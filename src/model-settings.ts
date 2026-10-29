import type { DatabaseSync } from "node:sqlite";

export type ManagedModel = {
	id: string;
	name: string;
	supportedEfforts?: string[] | null;
	inputModalities?: string[] | null;
	reasoningRequired: boolean;
};
export type ProviderRouting = "default" | "price" | "throughput" | "latency";
export type ModelDiscovery = {
	status: "no-key" | "loading" | "success" | "error";
	models: ManagedModel[];
};
export type ModelSettings = {
	discovery: ModelDiscovery;
	providerRouting: ProviderRouting;
	apiKeyConfigured: boolean;
	defaultModelId: string | null;
	models: ManagedModel[];
};

export class ModelSettingsError extends Error {
	code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export function createModelSettings(
	database: DatabaseSync,
	fetchCatalog: typeof fetch,
	notifyChange: () => void,
) {
	let discovery: ModelDiscovery = { status: "no-key", models: [] };
	let generation = 0;
	function read(): ModelSettings {
		const settings = database
			.prepare(
				"SELECT api_key,default_model_id,provider_routing FROM settings WHERE id=1",
			)
			.get();
		return {
			discovery,
			providerRouting: settings?.provider_routing as ProviderRouting,
			apiKeyConfigured: !!settings?.api_key,
			defaultModelId:
				settings?.default_model_id === null
					? null
					: String(settings?.default_model_id),
			models: database
				.prepare("SELECT id,name,metadata FROM managed_models ORDER BY rowid")
				.all()
				.map((row) => ({
					id: String(row.id),
					name: String(row.name),
					...JSON.parse(String(row.metadata)),
				})),
		};
	}
	let catalogLoading: Promise<ManagedModel[]> | undefined;
	const loadCatalog = (refresh = false): Promise<ManagedModel[]> => {
		const key = String(readCredential());
		if (!key) return Promise.resolve([]);
		if (catalogLoading) return catalogLoading;
		if (!refresh && discovery.status === "success")
			return Promise.resolve(discovery.models);
		if (!refresh && discovery.status === "error")
			return Promise.reject(new ModelSettingsError("modelCatalogFailed"));
		const requestGeneration = generation;
		discovery = { status: "loading", models: [] };
		notifyChange();
		const operation = (async () => {
			const response = await fetchCatalog(
				"https://openrouter.ai/api/v1/models/user?output_modalities=text",
				{ method: "GET", headers: { Authorization: `Bearer ${key}` } },
			);
			if (!response.ok) throw new ModelSettingsError("modelCatalogFailed");
			const body = await response.json();
			if (!Array.isArray(body?.data))
				throw new ModelSettingsError("modelCatalogFailed");
			const rows = body.data as {
				id: string;
				name: string;
				architecture?: {
					output_modalities?: string[];
					input_modalities?: string[] | null;
				};
				reasoning?: { supported_efforts?: unknown; mandatory?: boolean };
			}[];
			if (
				rows.some(
					(row) =>
						typeof row?.id !== "string" ||
						!row.id.trim() ||
						typeof row.name !== "string" ||
						!Array.isArray(row.architecture?.output_modalities),
				)
			)
				throw new ModelSettingsError("modelCatalogFailed");
			const next: ManagedModel[] = rows
				.filter((row) => row.architecture?.output_modalities?.includes("text"))
				.map((row) => ({
					id: row.id,
					name: row.name,
					...(Array.isArray(row.architecture?.input_modalities) &&
					row.architecture.input_modalities.every(
						(value) => typeof value === "string",
					)
						? { inputModalities: row.architecture.input_modalities }
						: {}),
					...(row.reasoning &&
					Object.hasOwn(row.reasoning, "supported_efforts") &&
					(row.reasoning.supported_efforts === null ||
						(Array.isArray(row.reasoning.supported_efforts) &&
							row.reasoning.supported_efforts.every(
								(effort: unknown) => typeof effort === "string",
							)))
						? { supportedEfforts: row.reasoning.supported_efforts }
						: {}),
					reasoningRequired: row.reasoning?.mandatory === true,
				}));
			if (requestGeneration !== generation) return discovery.models;
			database.exec("BEGIN");
			try {
				// Read membership after the network wait, preserving concurrent additions/removals.
				for (const model of read().models) {
					const found = next.find((row) => row.id === model.id);
					if (!found) continue;
					const { id, name, ...metadata } = found;
					database
						.prepare("UPDATE managed_models SET name=?,metadata=? WHERE id=?")
						.run(name, JSON.stringify(metadata), id);
				}
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
			discovery = { status: "success", models: next };
			notifyChange();
			return next;
		})()
			.catch(() => {
				if (requestGeneration !== generation) return discovery.models;
				discovery = { status: "error", models: [] };
				notifyChange();
				throw new ModelSettingsError("modelCatalogFailed");
			})
			.finally(() => {
				if (catalogLoading === operation) catalogLoading = undefined;
			});
		catalogLoading = operation;
		return operation;
	};

	const readCredential = () =>
		database.prepare("SELECT api_key FROM settings WHERE id=1").get()
			?.api_key ?? "";
	const requireDiscovery = () => {
		if (discovery.status !== "success")
			throw new ModelSettingsError("modelCatalogFailed");
	};
	const requireAvailable = (id: unknown) => {
		requireDiscovery();
		if (!discovery.models.some((model) => model.id === id))
			throw new ModelSettingsError("invalidModel");
	};
	const update = (input: Record<string, unknown>) => {
		const previousKey = readCredential();
		if (
			input.apiKey !== undefined &&
			(typeof input.apiKey !== "string" || /[\r\n]/.test(input.apiKey))
		)
			throw new ModelSettingsError("invalidApiKey");
		if (
			input.removeApiKey !== undefined &&
			typeof input.removeApiKey !== "boolean"
		)
			throw new ModelSettingsError("invalidInput");
		if (
			input.defaultModelId !== undefined &&
			input.defaultModelId !== null &&
			(typeof input.defaultModelId !== "string" ||
				!database
					.prepare("SELECT 1 FROM managed_models WHERE id=?")
					.get(input.defaultModelId))
		)
			throw new ModelSettingsError("invalidModel");
		if (
			input.defaultModelId !== undefined &&
			input.defaultModelId !== read().defaultModelId
		) {
			const nextKey =
				input.removeApiKey === true
					? ""
					: typeof input.apiKey === "string"
						? input.apiKey.trim()
						: previousKey;
			if (nextKey !== previousKey)
				throw new ModelSettingsError("modelCatalogFailed");
			requireDiscovery();
			if (input.defaultModelId !== null) requireAvailable(input.defaultModelId);
		}
		if (
			Object.hasOwn(input, "providerRouting") &&
			!["default", "price", "throughput", "latency"].includes(
				input.providerRouting as string,
			)
		)
			throw new ModelSettingsError("invalidInput");
		database.exec("BEGIN");
		try {
			if (input.removeApiKey === true)
				database.prepare("UPDATE settings SET api_key=NULL WHERE id=1").run();
			else if (typeof input.apiKey === "string")
				database
					.prepare("UPDATE settings SET api_key=? WHERE id=1")
					.run(input.apiKey.trim() || null);
			if (input.providerRouting !== undefined)
				database
					.prepare("UPDATE settings SET provider_routing=? WHERE id=1")
					.run(input.providerRouting as ProviderRouting);
			if (input.defaultModelId !== undefined)
				database
					.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
					.run(input.defaultModelId as string | null);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		if (readCredential() !== previousKey) {
			generation++;
			catalogLoading = undefined;
			discovery = {
				status: readCredential() ? "loading" : "no-key",
				models: [],
			};
			void loadCatalog().catch(() => {});
		}
		notifyChange();
		return read();
	};
	const add = (id: unknown) => {
		if (typeof id !== "string" || !id.trim())
			throw new ModelSettingsError("invalidModel");
		const existing = read();
		if (existing.models.some((model) => model.id === id)) {
			return { ...existing, firstModelAdded: false };
		}
		requireAvailable(id);
		const model = discovery.models.find((model) => model.id === id);
		if (!model) throw new ModelSettingsError("invalidModel");
		const { name, ...metadata } = model;
		delete (metadata as Partial<ManagedModel>).id;
		let firstModelAdded = false;
		database.exec("BEGIN");
		try {
			const wasEmpty = read().models.length === 0;
			const inserted = database
				.prepare(
					"INSERT INTO managed_models(id,name,metadata) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
				)
				.run(id, name, JSON.stringify(metadata));
			firstModelAdded = wasEmpty && inserted.changes > 0;
			if (firstModelAdded)
				database
					.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
					.run(id);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		notifyChange();
		return { ...read(), firstModelAdded };
	};
	const remove = (id: string) => {
		requireDiscovery();
		database.exec("BEGIN");
		try {
			const settings = read();
			database
				.prepare("UPDATE chats SET reasoning_effort=NULL WHERE model_id=?")
				.run(id);
			database.prepare("DELETE FROM managed_models WHERE id=?").run(id);
			if (settings.defaultModelId === id) {
				const remaining = settings.models.filter((model) => model.id !== id);
				const replacement =
					discovery.models.find((model) =>
						remaining.some((enabled) => enabled.id === model.id),
					) ?? remaining[0];
				database
					.prepare("UPDATE settings SET default_model_id=? WHERE id=1")
					.run(replacement?.id ?? null);
			}
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		notifyChange();
		return read();
	};
	if (readCredential()) void loadCatalog().catch(() => {});
	return {
		read,
		readCredential,
		update,
		loadCatalog,
		add,
		remove,
		requireDiscovery,
		requireAvailable,
	};
}
