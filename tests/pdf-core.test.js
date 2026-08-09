"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PDFLib = require("../vendor/pdf-lib.min.js");
globalThis.PDFLib = PDFLib;
const core = require("../pdf-core.js");

async function run() {
  assert.equal(core.normalizeAngle(450), 90);
  assert.equal(core.normalizeAngle(-90), 270);
  assert.equal(core.createOutputName("資料.PDF"), "資料_rotated.pdf");
  assert.equal(core.createOutputName(""), "document_rotated.pdf");
  assert.equal(core.createEditedOutputName("資料.PDF"), "資料_edited.pdf");
  assert.equal(core.createMergedOutputName("資料.PDF"), "資料_merged.pdf");

  const source = await PDFLib.PDFDocument.create();
  source.addPage([300, 500]);
  source.addPage([600, 400]);
  const sourceBytes = await source.save();

  const document = await PDFLib.PDFDocument.load(sourceBytes);
  const original = document.getPages().map((page) => page.getRotation().angle);
  core.rotatePages(document, [0, 1], 90);
  core.rotatePages(document, [1], -180);

  assert.deepEqual(
    document.getPages().map((page) => core.normalizeAngle(page.getRotation().angle)),
    [90, 270]
  );
  assert.deepEqual(
    [core.getPageState(document.getPage(0)).displayWidth, core.getPageState(document.getPage(0)).displayHeight],
    [500, 300]
  );

  const outputBytes = await document.save();
  const reopened = await PDFLib.PDFDocument.load(outputBytes);
  assert.deepEqual(
    reopened.getPages().map((page) => core.normalizeAngle(page.getRotation().angle)),
    [90, 270]
  );

  core.resetRotations(reopened, original);
  assert.deepEqual(
    reopened.getPages().map((page) => core.normalizeAngle(page.getRotation().angle)),
    [0, 0]
  );

  const other = await PDFLib.PDFDocument.create();
  other.addPage([700, 300]);
  other.addPage([720, 320]);
  core.rotatePages(reopened, [0], 90);
  const merged = await core.mergePdfPages([
    { pdfDocument: other, pages: [{ sourceIndex: 1 }] },
    { pdfDocument: reopened, pages: [{ sourceIndex: 0 }] }
  ]);
  assert.deepEqual(
    merged.getPages().map((page) => [
      page.getWidth(),
      page.getHeight(),
      core.normalizeAngle(page.getRotation().angle)
    ]),
    [
      [720, 320, 0],
      [300, 500, 90]
    ]
  );

  const interleaved = await core.mergeOrderedPdfPages([
    { pdfDocument: reopened, sourceIndex: 1 },
    { pdfDocument: other, sourceIndex: 0 },
    { pdfDocument: reopened, sourceIndex: 0 }
  ]);
  assert.deepEqual(
    interleaved.getPages().map((page) => [
      page.getWidth(),
      page.getHeight(),
      core.normalizeAngle(page.getRotation().angle)
    ]),
    [
      [600, 400, 0],
      [700, 300, 0],
      [300, 500, 90]
    ]
  );

  const outputPath = path.join(os.tmpdir(), "pdf-tools-web-app-test.pdf");
  fs.writeFileSync(outputPath, await reopened.save());
  assert.ok(fs.statSync(outputPath).size > 0);
  fs.unlinkSync(outputPath);

  process.stdout.write("PDF rotation tests: OK\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
