const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "coursescribe-manual-"));
app.setPath("userData", root);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
app.disableHardwareAcceleration();
require("../main.cjs");
app.whenReady().then(() => console.log(`CourseScribe manual test data: ${root}`));
