import { createCanvas, type Canvas } from "@napi-rs/canvas";
import * as ort from "onnxruntime-node";
import { decodeRegions } from "./layout";
import { model } from "./model";

const size = 800;
// The page is stretched to the square model input. The FP16 export reports
// boxes in that input space and ignores scale_factor, so decode against it.
export async function detectRegions(
  session: ort.InferenceSession,
  page: Canvas,
) {
  const input = createCanvas(size, size),
    context = input.getContext("2d");
  context.drawImage(page, 0, 0, size, size);
  const rgba = context.getImageData(0, 0, size, size).data;
  const area = size * size;
  const rgb = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    rgb[i] = rgba[i * 4] / 255;
    rgb[i + area] = rgba[i * 4 + 1] / 255;
    rgb[i + 2 * area] = rgba[i * 4 + 2] / 255;
  }
  const result = await session.run(
    {
      image: new ort.Tensor("float32", rgb, [1, 3, size, size]),
      im_shape: new ort.Tensor(
        "float32",
        new Float32Array([size, size]),
        [1, 2],
      ),
      scale_factor: new ort.Tensor("float32", new Float32Array([1, 1]), [1, 2]),
    },
    [model.output],
  );
  try {
    return decodeRegions(result[model.output].data as Float32Array, size, size);
  } finally {
    for (const tensor of Object.values(result)) tensor.dispose();
  }
}
