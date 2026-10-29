import { useCallback, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

export function SettingsHelp({
	id,
	label,
	children,
}: {
	id?: string;
	label: string;
	children: string;
}) {
	const { t } = useTranslation();
	const generated = useId();
	const helpId = id ?? `settings-help-${generated}`;
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLSpanElement>(null);
	const pinned = useRef(false);
	const suppressed = useRef(false);
	const hovered = useRef(false);
	const focused = useRef(false);
	const dismiss = useCallback(() => {
		pinned.current = false;
		suppressed.current = true;
		popup.current?.hidePopover();
	}, []);
	const position = useCallback(() => {
		const button = trigger.current;
		const help = popup.current;
		const content = button?.closest(".settings-content");
		if (!button || !help?.matches(":popover-open") || !content) return;
		const anchor = button.getBoundingClientRect();
		const bounds = content.getBoundingClientRect();
		if (anchor.top < bounds.top - 1 || anchor.bottom > bounds.bottom + 1) {
			dismiss();
			return;
		}
		const width = Math.min(360, bounds.width - 16);
		const below = Math.max(0, bounds.bottom - anchor.bottom - 8);
		const above = Math.max(0, anchor.top - bounds.top - 8);
		help.style.width = `${width}px`;
		const upwards = help.scrollHeight > below && above > below;
		help.style.maxHeight = `${upwards ? above : below}px`;
		help.style.left = `${Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - width - 8))}px`;
		help.style.top = `${upwards ? anchor.top - help.getBoundingClientRect().height : anchor.bottom}px`;
	}, [dismiss]);
	function reveal() {
		if (!suppressed.current) {
			popup.current?.showPopover();
			position();
		}
	}
	function leave() {
		if (!hovered.current && !focused.current && !pinned.current)
			popup.current?.hidePopover();
	}
	useEffect(() => {
		const element = popup.current;
		const keydown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !element?.matches(":popover-open")) return;
			event.preventDefault();
			event.stopPropagation();
			dismiss();
		};
		const outside = (event: PointerEvent) => {
			if (
				element?.matches(":popover-open") &&
				event.target instanceof Node &&
				!element.contains(event.target) &&
				!trigger.current?.contains(event.target)
			)
				dismiss();
		};
		document.addEventListener("scroll", position, true);
		window.addEventListener("resize", position);
		const observer = new ResizeObserver(position);
		if (trigger.current) observer.observe(trigger.current);
		const content = trigger.current?.closest(".settings-content");
		if (content) observer.observe(content);
		document.addEventListener("keydown", keydown, true);
		document.addEventListener("pointerdown", outside, true);
		return () => {
			element?.hidePopover();
			observer.disconnect();
			document.removeEventListener("scroll", position, true);
			window.removeEventListener("resize", position);
			document.removeEventListener("keydown", keydown, true);
			document.removeEventListener("pointerdown", outside, true);
		};
	}, [dismiss, position]);
	return (
		<span
			className="inline-flex align-middle font-normal"
			onPointerEnter={() => {
				hovered.current = true;
				suppressed.current = false;
				reveal();
			}}
			onPointerLeave={() => {
				hovered.current = false;
				leave();
			}}
		>
			<button
				ref={trigger}
				type="button"
				aria-label={t("settingsHelp", { setting: label })}
				aria-describedby={helpId}
				className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-sm text-neutral-500 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
				onFocus={() => {
					focused.current = true;
					suppressed.current = false;
					reveal();
				}}
				onBlur={() => {
					focused.current = false;
					leave();
				}}
				onPointerDown={(event) => event.preventDefault()}
				onClick={() => {
					if (pinned.current) dismiss();
					else {
						suppressed.current = false;
						pinned.current = true;
						reveal();
					}
				}}
			>
				<span aria-hidden="true">ⓘ</span>
			</button>
			<span
				ref={popup}
				id={helpId}
				role="tooltip"
				popover="auto"
				className="settings-help picker-popup"
				onToggle={(event) => {
					if (event.newState === "closed") {
						pinned.current = false;
						suppressed.current = true;
					}
				}}
			>
				{children}
			</span>
		</span>
	);
}
