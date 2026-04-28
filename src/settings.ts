import { App, PluginSettingTab, Setting } from "obsidian";
import { t as tr } from "./i18n";
import type TaskCenterPlugin from "./main";

export class TaskCenterSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: TaskCenterPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: tr("settings.header") });

    // US-118: removed legacy Inbox path / grouping tag settings. Quick Add
    // writes only to Obsidian Daily Notes; tags are ordinary markdown data
    // surfaced through filters and saved views.

    // US-111: default-tab setting decides which view first-open lands on
    // (week / month / completed / unscheduled). `lastTab` (US-405)
    // overrides this once the user has actually opened the board at
    // least once; this setting is the cold-start fallback.
    // see USER_STORIES.md
    new Setting(containerEl)
      .setName(tr("settings.defaultView.name"))
      .setDesc(tr("settings.defaultView.desc"))
      .addDropdown((dd) =>
        dd
          .addOptions({
            today: tr("settings.defaultView.today"),
            week: tr("settings.defaultView.week"),
            month: tr("settings.defaultView.month"),
            completed: tr("settings.defaultView.completed"),
            unscheduled: tr("settings.defaultView.unscheduled"),
          })
          .setValue(this.plugin.settings.defaultView)
          .onChange(async (v) => {
            this.plugin.settings.defaultView = v as "today" | "week" | "month" | "completed" | "unscheduled";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(tr("settings.weekStart.name"))
      .setDesc(tr("settings.weekStart.desc"))
      .addDropdown((dd) =>
        dd
          .addOption("1", tr("settings.weekStart.mon"))
          .addOption("0", tr("settings.weekStart.sun"))
          .setValue(this.plugin.settings.weekStartsOn.toString())
          .onChange(async (v) => {
            this.plugin.settings.weekStartsOn = v === "0" ? 0 : 1;
            await this.plugin.saveSettings();
          }),
      );

    // US-110: "open board on startup" toggle. Default off — the board
    // costs a vault scan on first open and we don't want to slow Obsidian
    // launch unless the user opted in. Wired in main.ts:onload via the
    // `app.workspace.onLayoutReady → activateView` callback.
    // see USER_STORIES.md
    new Setting(containerEl)
      .setName(tr("settings.openOnStartup.name"))
      .setDesc(tr("settings.openOnStartup.desc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
          this.plugin.settings.openOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(tr("settings.stampCreated.name"))
      .setDesc(tr("settings.stampCreated.desc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.stampCreated).onChange(async (v) => {
          this.plugin.settings.stampCreated = v;
          await this.plugin.saveSettings();
        }),
      );

    // US-510: mobile-specific settings. Always rendered so cross-device
    // syncs (desktop user configuring their phone behaviour) work; the
    // values are no-ops on desktop. Heading is shown unconditionally.
    // The mobileForceLayout toggle below also implements US-502 (force
    // narrow layout regardless of viewport width).
    // see USER_STORIES.md
    {
      containerEl.createEl("h3", { text: tr("settings.mobileHeader") });

      new Setting(containerEl)
        .setName(tr("settings.mobileForceLayout.name"))
        .setDesc(tr("settings.mobileForceLayout.desc"))
        .addToggle((tg) =>
          tg.setValue(this.plugin.settings.mobileForceLayout).onChange(async (v) => {
            this.plugin.settings.mobileForceLayout = v;
            await this.plugin.saveSettings();
            // Tell the open board (if any) to re-evaluate its layout class
            // immediately, no leaf reopen required.
            this.plugin.refreshOpenViews().catch(() => {/* ignore */});
          }),
        );
    }

    containerEl.createEl("h3", { text: tr("settings.cliHeader") });
    const cliHelp = containerEl.createEl("div", { cls: "setting-item-description" });
    cliHelp.createEl("p", { text: tr("settings.cliHelp") });
    const pre = cliHelp.createEl("pre");
    pre.setText(
      [
        "obsidian task-center:list scheduled=today",
        "obsidian task-center:list scheduled=unscheduled tag='#tag'",
        "obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25",
        "obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-23",
        "obsidian task-center:add text=\"去营业厅问携号转网\" tag=\"#tag\" scheduled=2026-04-26",
        "obsidian task-center:stats days=7 group=象限",
      ].join("\n"),
    );
    cliHelp.createEl("p", { text: tr("settings.cliAiNote") });
  }
}
