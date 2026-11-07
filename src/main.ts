import { App, ButtonComponent, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";
import { Entry, NoticeLog, when } from "./log";

interface Settings { persist: boolean; max: number; statusBar: boolean }
const DEFAULTS: Settings = { persist: true, max: 200, statusBar: true };
interface Data { settings?: Partial<Settings>; entries?: Entry[] }

export default class NoticeHistory extends Plugin {
	settings: Settings = { ...DEFAULTS };
	log = new NoticeLog();
	private ids = new WeakMap<HTMLElement, number>();
	private observers: MutationObserver[] = [];
	private unseen = 0;
	private statusEl?: HTMLElement;
	private saveTimer = 0;
	private quiet = 0; // our own "Copied" notices are not logged
	private modal?: HistoryModal;

	async onload() {
		const data = ((await this.loadData()) as Data | null) ?? {};
		this.settings = { ...DEFAULTS, ...data.settings };
		this.log.load(this.settings.persist ? data.entries : [], this.settings.max);

		this.addRibbonIcon("bell", "Notification history", () => this.open());
		this.addCommand({ id: "open", name: "Show notification history", callback: () => this.open() });
		this.addCommand({ id: "clear", name: "Clear notification history", callback: () => { this.log.clear(); this.changed(); } });
		this.addSettingTab(new HistoryTab(this.app, this));
		this.drawStatus();

		// Notices live in a .notice-container that Obsidian adds to <body> of the window that shows them.
		this.watchWindow(document);
		this.registerEvent(this.app.workspace.on("window-open", (w) => this.watchWindow(w.doc)));
	}

	onunload() {
		this.observers.forEach((o) => o.disconnect());
		window.clearTimeout(this.saveTimer);
		void this.persist();
	}

	private watchWindow(doc: Document) {
		const body = doc.body;
		const hook = (c: Element) => {
			if (!c.hasClass("notice-container")) return;
			Array.from(c.children).forEach((n) => this.seen(n as HTMLElement));
			const o = new MutationObserver((muts) => {
				for (const m of muts) {
					if (m.type === "childList" && m.target === c) m.addedNodes.forEach((n) => n.instanceOf(HTMLElement) && this.seen(n));
					else this.edited(m.target);
				}
			});
			o.observe(c, { childList: true, subtree: true, characterData: true });
			this.observers.push(o);
		};
		Array.from(body.children).forEach(hook);
		const top = new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => n.instanceOf(Element) && hook(n))));
		top.observe(body, { childList: true });
		this.observers.push(top);
	}

	private text(el: HTMLElement): string {
		const msg = el.querySelector<HTMLElement>(".notice-message") ?? el;
		return (msg.innerText || msg.textContent || "").trim();
	}

	private seen(el: HTMLElement) {
		if (!el.hasClass("notice") || this.ids.has(el)) return;
		if (this.quiet > 0) { this.quiet--; this.ids.set(el, 0); return; }
		const e = this.log.add(this.text(el), Date.now());
		if (!e) return;
		this.ids.set(el, e.id);
		this.unseen++;
		this.changed();
	}

	private edited(node: Node) {
		const el = (node.instanceOf(HTMLElement) ? node : node.parentElement)?.closest<HTMLElement>(".notice");
		if (!el) return;
		const id = this.ids.get(el);
		if (id === undefined) return this.seen(el); // text arrived after the element
		if (id) { this.log.update(id, this.text(el)); this.changed(); }
	}

	changed() {
		this.drawStatus();
		this.modal?.draw();
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.persist(), 2000);
	}

	async persist() {
		await this.saveData({ settings: this.settings, entries: this.settings.persist ? this.log.entries : [] } as Data);
	}

	drawStatus() {
		if (!this.settings.statusBar) { this.statusEl?.remove(); this.statusEl = undefined; return; }
		if (!this.statusEl) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("mod-clickable", "nh-status");
			this.statusEl.setAttr("aria-label", "Notification history");
			this.statusEl.onClickEvent(() => this.open());
		}
		this.statusEl.empty();
		setIcon(this.statusEl.createSpan(), "bell");
		if (this.unseen) this.statusEl.createSpan({ cls: "nh-badge", text: String(this.unseen) });
	}

	open() {
		this.unseen = 0;
		this.drawStatus();
		if (this.modal) return;
		this.modal = new HistoryModal(this.app, this, () => (this.modal = undefined));
		this.modal.open();
	}

	copied(what: string) {
		this.quiet++;
		new Notice(`Copied ${what}`, 1500);
	}
}

class HistoryModal extends Modal {
	private filter = "";
	private listEl!: HTMLElement;
	constructor(app: App, private plugin: NoticeHistory, private onGone: () => void) { super(app); }

	onOpen() {
		this.modalEl.addClass("nh-modal");
		this.titleEl.setText("Notification history");
		const bar = this.contentEl.createDiv({ cls: "nh-bar" });
		const search = bar.createEl("input", { type: "search", placeholder: "Filter", cls: "nh-search" });
		search.addEventListener("input", () => { this.filter = search.value.toLowerCase(); this.draw(); });
		new ButtonComponent(bar).setButtonText("Copy all").onClick(() => {
			void navigator.clipboard.writeText(this.shown().map((e) => `${when(e.time, Date.now())}  ${e.text}`).join("\n\n"));
			this.plugin.copied("all");
		});
		new ButtonComponent(bar).setButtonText("Clear").setWarning().onClick(() => { this.plugin.log.clear(); this.plugin.changed(); });
		this.listEl = this.contentEl.createDiv({ cls: "nh-list" });
		this.draw();
	}

	onClose() { this.contentEl.empty(); this.onGone(); }

	private shown() {
		const f = this.filter;
		return this.plugin.log.entries.filter((e) => !f || e.text.toLowerCase().includes(f));
	}

	draw() {
		if (!this.listEl) return;
		this.listEl.empty();
		const list = this.shown();
		if (!list.length) {
			this.listEl.createDiv({ cls: "nh-empty", text: this.filter ? "No notification matches." : "No notifications yet. They will appear here as Obsidian and your plugins show them." });
			return;
		}
		const now = Date.now();
		for (const e of list) {
			const row = this.listEl.createDiv({ cls: "nh-row" });
			const meta = row.createDiv({ cls: "nh-meta" });
			meta.createSpan({ cls: "nh-time", text: when(e.time, now) });
			if (e.count > 1) meta.createSpan({ cls: "nh-count", text: `×${e.count}` });
			const copy = meta.createDiv({ cls: "clickable-icon nh-copy", attr: { "aria-label": "Copy" } });
			setIcon(copy, "copy");
			copy.onClickEvent(() => { void navigator.clipboard.writeText(e.text); this.plugin.copied("notification"); });
			row.createDiv({ cls: "nh-text", text: e.text });
		}
	}
}

class HistoryTab extends PluginSettingTab {
	constructor(app: App, private plugin: NoticeHistory) { super(app, plugin); }
	display() {
		const { containerEl: el } = this;
		const p = this.plugin;
		el.empty();
		new Setting(el).setName("Keep history after restart").setDesc("Off: the list starts empty each time Obsidian opens.")
			.addToggle((t) => t.setValue(p.settings.persist).onChange(async (v) => { p.settings.persist = v; await p.persist(); }));
		new Setting(el).setName("Notifications to keep").setDesc("Older ones are dropped.")
			.addDropdown((d) => {
				for (const n of [50, 100, 200, 500, 1000]) d.addOption(String(n), String(n));
				d.setValue(String(p.settings.max)).onChange(async (v) => { p.settings.max = Number(v); p.log.load(p.log.entries, p.settings.max); await p.persist(); });
			});
		new Setting(el).setName("Bell in the status bar").setDesc("Shows how many notifications came since you last looked. Desktop only; on mobile use the ribbon or the command.")
			.addToggle((t) => t.setValue(p.settings.statusBar).onChange(async (v) => { p.settings.statusBar = v; p.drawStatus(); await p.persist(); }));
	}
}
