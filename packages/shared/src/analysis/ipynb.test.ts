import { describe, expect, test } from "vitest"
import { parseIpynb } from "./ipynb"

describe("parseIpynb", () => {
  test("reads Markdown and code cells with text, image and other outputs", () => {
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["# Results\n", "Loss went down."] },
        {
          cell_type: "code",
          metadata: {},
          execution_count: 1,
          source: "print('hi')\n1 + 1",
          outputs: [
            { output_type: "stream", name: "stdout", text: ["hi\n"] },
            { output_type: "execute_result", execution_count: 1, data: { "text/plain": ["2"] } },
            {
              output_type: "display_data",
              data: { "image/png": "iVBORw0KGgo=\n", "text/plain": "<Figure>" },
            },
            { output_type: "display_data", data: { "application/vnd.plotly.v1+json": {} } },
            { output_type: "error", ename: "ValueError", evalue: "bad", traceback: [] },
          ],
        },
      ],
    }

    expect(parseIpynb(JSON.stringify(notebook))).toEqual({
      cells: [
        { type: "markdown", source: "# Results\nLoss went down.", outputs: [] },
        {
          type: "code",
          source: "print('hi')\n1 + 1",
          outputs: [
            { type: "text", text: "hi\n" },
            { type: "text", text: "2" },
            { type: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
            { type: "unsupported", outputType: "display_data" },
            { type: "text", text: "ValueError: bad" },
          ],
        },
      ],
    })
  })

  test("refuses JSON that is not a notebook", () => {
    expect(() => parseIpynb('{"cells": "nope"}')).toThrow(/not a Jupyter notebook/)
  })
})
