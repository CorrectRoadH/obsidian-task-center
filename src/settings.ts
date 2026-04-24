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

    new Setting(containerEl)
      .setName(tr("settings.inbox.name"))
      .setDesc(tr("settings.inbox.desc"))
      .addText((text) =>
        text
          .setPlaceholder("Tasks/Inbox.md")
          .setValue(this.plugin.settings.inboxPath)
          .onChange(async (v) => {
            this.plugin.settings.inboxPath = v || "Tasks/Inbox.md";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(tr("settings.dailyFolder.name"))
      .setDesc(tr("settings.dailyFolder.desc"))
      .addText((text) =>
        text
          .setPlaceholder("Daily")
          .setValue(this.plugin.settings.dailyFolder)
          .onChange(async (v) => {
            this.plugin.settings.dailyFolder = v || "Daily";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(tr("settings.defaultView.name"))
      .setDesc(tr("settings.defaultView.desc"))
      .addDropdown((dd) =>
        dd
          .addOptions({
            week: tr("settings.defaultView.week"),
            month: tr("settings.defaultView.month"),
            completed: tr("settings.defaultView.completed"),
            unscheduled: tr("settings.defaultView.unscheduled"),
          })
          .setValue(this.plugin.settings.defaultView)
          .onChange(async (v) => {
            this.plugin.settings.defaultView = v as "week" | "month" | "completed" | "unscheduled";
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

    new Setting(containerEl)
      .setName(tr("settings.openOnStartup.name"))
      .setDesc(tr("settings.openOnStartup.desc"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
          this.plugin.settings.openOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: tr("settings.cliHeader") });
    const cliHelp = containerEl.createEl("div", { cls: "setting-item-description" });
    cliHelp.createEl("p", { text: tr("settings.cliHelp") });
    const pre = cliHelp.createEl("pre");
    pre.setText(
      [
        "obsidian task-center:list scheduled=today",
        "obsidian task-center:list scheduled=unscheduled tag='#2象限'",
        "obsidian task-center:schedule ref=Tasks/Inbox.md:L42 date=2026-04-25",
        "obsidian task-center:done ref=Tasks/Inbox.md:L42 at=2026-04-23",
        'obsidian task-center:add text="去营业厅问携号转网" tag="#3象限" scheduled=2026-04-26',
        "obsidian task-center:stats days=7 group=象限",
      ].join("\n"),
    );
    cliHelp.createEl("p", { text: tr("settings.cliAiNote") });
  }
}
