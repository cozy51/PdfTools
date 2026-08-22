"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

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

  // 画面座標とページ座標の往復。回転しても元の点へ戻る必要がある。
  const pageWidth = 400;
  const pageHeight = 600;
  [0, 90, 180, 270].forEach((rotation) => {
    const size = core.getDisplaySize(pageWidth, pageHeight, rotation);
    const quarterTurn = rotation === 90 || rotation === 270;
    assert.deepEqual(
      [size.width, size.height],
      quarterTurn ? [pageHeight, pageWidth] : [pageWidth, pageHeight]
    );

    [
      [0, 0],
      [size.width, 0],
      [0, size.height],
      [size.width, size.height],
      [37.5, 129.25]
    ].forEach(([displayX, displayY]) => {
      const user = core.toUserPoint(displayX, displayY, pageWidth, pageHeight, rotation);
      assert.ok(user.x >= -1e-9 && user.x <= pageWidth + 1e-9);
      assert.ok(user.y >= -1e-9 && user.y <= pageHeight + 1e-9);
      const display = core.toDisplayPoint(
        user.x,
        user.y,
        pageWidth,
        pageHeight,
        rotation
      );
      assert.ok(Math.abs(display.x - displayX) < 1e-9);
      assert.ok(Math.abs(display.y - displayY) < 1e-9);
    });
  });

  // 回転していないページでは、画面の左上がページ座標の左上になる。
  assert.deepEqual(core.toUserPoint(0, 0, pageWidth, pageHeight, 0), {
    x: 0,
    y: pageHeight
  });
  // 90度回転した表示では、画面の左上はページの左下にあたる。
  assert.deepEqual(core.toUserPoint(0, 0, pageWidth, pageHeight, 90), { x: 0, y: 0 });

  // テキストは左上を基準に持ち、書き込み時は左下を渡す必要がある。
  const upright = core.getTextPlacement({ x: 100, y: 500, rotation: 0 }, 80, 20);
  assert.deepEqual(
    [upright.x, upright.y, upright.width, upright.height, upright.rotate],
    [100, 480, 80, 20, 0]
  );
  const turned = core.getTextPlacement({ x: 100, y: 500, rotation: 90 }, 80, 20);
  assert.ok(Math.abs(turned.x - 120) < 1e-9);
  assert.ok(Math.abs(turned.y - 500) < 1e-9);
  assert.equal(turned.rotate, 90);

  // 手で引いた直線の水平・垂直補正。始点は動かさない。
  const origin = { x: 100, y: 100 };
  assert.deepEqual(core.snapStraightLine(origin, { x: 300, y: 105 }), {
    x: 300,
    y: 100
  });
  assert.deepEqual(core.snapStraightLine(origin, { x: 95, y: 300 }), {
    x: 100,
    y: 300
  });
  // 傾きがはっきりしている線はそのまま残す。
  assert.deepEqual(core.snapStraightLine(origin, { x: 300, y: 160 }), {
    x: 300,
    y: 160
  });
  assert.deepEqual(core.snapStraightLine(origin, { x: 160, y: 300 }), {
    x: 160,
    y: 300
  });
  // 長さが0のときは判定しようがないので、そのまま返す。
  assert.deepEqual(core.snapStraightLine(origin, { x: 100, y: 100 }), {
    x: 100,
    y: 100
  });
  // 許容角は呼び出し側から広げられる。
  assert.deepEqual(core.snapStraightLine(origin, { x: 300, y: 160 }, 20), {
    x: 300,
    y: 100
  });

  assert.deepEqual(core.getStrokeAppearance("marker"), {
    marker: true,
    opacity: 0.4
  });
  assert.deepEqual(core.getStrokeAppearance("pen"), { marker: false, opacity: 1 });
  assert.deepEqual(core.getStrokeAppearance(undefined), {
    marker: false,
    opacity: 1
  });

  assert.deepEqual(core.hexToRgb("#ff8000"), {
    red: 1,
    green: 128 / 255,
    blue: 0
  });

  // クロップボックスの原点がずれたページでも、その分だけ位置をずらす。
  const annotated = await PDFLib.PDFDocument.create();
  const annotatedPage = annotated.addPage([400, 600]);
  annotatedPage.setCropBox(20, 30, 360, 540);
  assert.deepEqual(core.getPageBox(annotatedPage), {
    x: 20,
    y: 30,
    width: 360,
    height: 540
  });

  const beforeAnnotations = (await annotated.save({ useObjectStreams: false })).length;
  core.applyPageAnnotations(
    annotatedPage,
    [
      {
        type: "stroke",
        points: [
          { x: 10, y: 10 },
          { x: 120, y: 90 },
          { x: 200, y: 20 }
        ],
        thickness: 3,
        color: "#1d4ed8"
      },
      { type: "stroke", points: [{ x: 40, y: 40 }], thickness: 5, color: "#e0245e" },
      {
        type: "stroke",
        variant: "marker",
        points: [
          { x: 20, y: 200 },
          { x: 300, y: 205 }
        ],
        thickness: 16,
        color: "#ffe14d"
      }
    ],
    core.getPageBox(annotatedPage)
  );
  // オブジェクトストリームにまとめられると中身を確認できないため、
  // ここでは展開したまま保存する。
  const annotatedBytes = await annotated.save({ useObjectStreams: false });
  assert.ok(annotatedBytes.length > beforeAnnotations);

  // 蛍光ペンは半透明かつ乗算で重ねる。継ぎ目が濃くならないよう、ひと続きの
  // パスを一度で描いていることも確かめる。
  const content = Buffer.from(annotatedBytes).toString("latin1");
  assert.match(content, /\/CA 0\.4/);
  assert.match(content, /\/BM \/Multiply/);
  const streams = [...content.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map((match) => {
      try {
        return zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
      } catch {
        return "";
      }
    })
    .join("\n");
  // 折れ線の角がとげのように飛び出さないよう、線のつなぎ方を丸めている。
  assert.match(streams, /^1 j$/m);
  // 蛍光ペンは平らな線端（囲いで指定）、ペンは丸い線端（各描画で上書き）。
  assert.match(streams, /^q\n1 j\n0 J$/m);
  assert.match(streams, /^1 J$/m);
  // クロップボックスの原点(20,30)を足した座標が、ひと続きのパスとして並ぶ。
  const markerPath = streams.match(/40 -230 m\s+320 -235 l\s+S/);
  assert.ok(markerPath, "蛍光ペンが1本のパスとして描かれていること");

  assert.throws(() => core.applyPageAnnotations(null, []), TypeError);

  const outputPath = path.join(os.tmpdir(), "pdf-tools-web-app-test.pdf");
  fs.writeFileSync(outputPath, await reopened.save());
  assert.ok(fs.statSync(outputPath).size > 0);
  fs.unlinkSync(outputPath);

  process.stdout.write("PDF rotation and annotation tests: OK\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
