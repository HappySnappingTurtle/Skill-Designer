import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = "http://127.0.0.1:8940";
const artifactDir = path.resolve(".skill-designer-dev/chrome-artifacts/original-graph-reference");
await mkdir(artifactDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20_000);
try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#graph.ready canvas").waitFor();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: path.join(artifactDir, "original-3d.png"), fullPage: true });
  const original3dPixels = await canvasPixelBounds(page, "3d");

  await page.locator('#modeSeg button[data-m="2d"]').click();
  await page.locator("#graph.ready canvas").waitFor();
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: path.join(artifactDir, "original-2d.png"), fullPage: true });
  const original2dPixels = await canvasPixelBounds(page, "2d");

  await page.locator('#modeSeg button[data-m="3d"]').click();
  await page.locator("#graph.ready canvas").waitFor();
  await page.locator("#search").fill("意图中枢");
  await page.locator("#search").press("Enter");
  await page.locator("#panel.show").waitFor();
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: path.join(artifactDir, "original-3d-detail.png"), fullPage: true });
  const report = { original3dPixels, original2dPixels };
  await writeFile(path.join(artifactDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

async function canvasPixelBounds(page, mode) {
  return page.locator("#graph.ready canvas").evaluate((canvas, graphMode) => {
    const width = canvas.width;
    const height = canvas.height;
    let pixels;
    if (graphMode === "2d") {
      pixels = canvas.getContext("2d")?.getImageData(0, 0, width, height).data;
    } else {
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (gl) {
        pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
    }
    if (!pixels) throw new Error(`Cannot inspect original ${graphMode} canvas pixels`);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let pixelCount = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 8) continue;
      const pixel = index / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixelCount += 1;
    }
    const contentWidth = maxX >= minX ? maxX - minX + 1 : 0;
    const contentHeight = maxY >= minY ? maxY - minY + 1 : 0;
    return {
      canvasWidth: width,
      canvasHeight: height,
      minX,
      minY,
      maxX,
      maxY,
      contentWidth,
      contentHeight,
      widthRatio: Number((contentWidth / width).toFixed(3)),
      heightRatio: Number((contentHeight / height).toFixed(3)),
      pixelCount
    };
  }, mode);
}
