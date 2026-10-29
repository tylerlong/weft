// Representative sanitized facts from the observed OpenRouter rejection, not successful generation.
export const guardrailRejection = (credential = "") => ({
	error: {
		code: 404,
		message: `No eligible endpoints. Model blocked by guardrail: 40 endpoints excluded.${credential ? ` Credential: ${credential}` : ""}`,
		metadata: {
			model: "deepseek/deepseek-v4.1-flash-1017",
			failed_routing_step: "Filter by Guardrails",
			ineligibility_reasons: [
				{ code: "model-ignored-by-guardrail", count: 40 },
			],
		},
	},
});
