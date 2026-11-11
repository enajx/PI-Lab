import { describe, expect, test } from "vitest"
import { buildNotebookLaunch } from "./notebookLaunch"

const JUPYTER_SERVER_ARGS = [
  "--no-browser",
  "--ServerApp.ip=127.0.0.1",
  "--ServerApp.port=42700",
  "--ServerApp.port_retries=0",
  "--ServerApp.token=tok",
  "--ServerApp.root_dir=/repo",
  `--ServerApp.tornado_settings={"headers":{"Content-Security-Policy":"frame-ancestors 'self' file:"}}`,
]

describe("buildNotebookLaunch", () => {
  test("Jupyter Lab in the project's environment opens the chosen notebook", () => {
    expect(
      buildNotebookLaunch({
        tool: "jupyter",
        environment: {
          kind: "project",
          python: "/repo/.venv/bin/python",
          label: "Project environment (.venv)",
          jupyterApp: "lab",
        },
        cwd: "/repo",
        absPath: "/repo/results/my run.ipynb",
        relPath: "results/my run.ipynb",
        port: 42_700,
        token: "tok",
        devServerOrigin: null,
      }),
    ).toEqual({
      command: "/repo/.venv/bin/python",
      args: ["-m", "jupyter", "lab", ...JUPYTER_SERVER_ARGS],
      url: "http://127.0.0.1:42700/lab/tree/results/my%20run.ipynb?token=tok",
    })
  })

  test("Jupyter Notebook when JupyterLab is missing, through uv run", () => {
    expect(
      buildNotebookLaunch({
        tool: "jupyter",
        environment: {
          kind: "uv-run",
          uv: "/bin/uv",
          label: "uv",
          jupyterApp: "notebook",
          fallbackReason: null,
        },
        cwd: "/repo",
        absPath: "/repo/a.ipynb",
        relPath: "a.ipynb",
        port: 42_700,
        token: "tok",
        devServerOrigin: null,
      }),
    ).toEqual({
      command: "/bin/uv",
      args: ["run", "jupyter", "notebook", ...JUPYTER_SERVER_ARGS],
      url: "http://127.0.0.1:42700/notebooks/a.ipynb?token=tok",
    })
  })

  test("a PI Lab copy of JupyterLab runs through uvx", () => {
    expect(
      buildNotebookLaunch({
        tool: "jupyter",
        environment: {
          kind: "pi-lab",
          uvx: "/bin/uvx",
          label: "uvx",
          jupyterApp: "lab",
          fallbackReason: null,
        },
        cwd: "/repo",
        absPath: "/repo/a.ipynb",
        relPath: "a.ipynb",
        port: 42_700,
        token: "tok",
        devServerOrigin: null,
      }).args,
    ).toEqual(["--from", "jupyterlab", "jupyter", "lab", ...JUPYTER_SERVER_ARGS])
  })

  test("marimo edit in the project's environment", () => {
    expect(
      buildNotebookLaunch({
        tool: "marimo",
        environment: {
          kind: "project",
          python: "/repo/.venv/bin/python",
          label: "Project environment (.venv)",
          jupyterApp: null,
        },
        cwd: "/repo",
        absPath: "/repo/nb.py",
        relPath: "nb.py",
        port: 42_701,
        token: "tok",
        devServerOrigin: null,
      }),
    ).toEqual({
      command: "/repo/.venv/bin/python",
      args: [
        "-m",
        "marimo",
        "edit",
        "/repo/nb.py",
        "--host",
        "127.0.0.1",
        "--port",
        "42701",
        "--headless",
        "--token-password",
        "tok",
      ],
      url: "http://127.0.0.1:42701/?access_token=tok",
    })
  })

  test("Jupyter may be framed by the packaged file: page and, in development, only the dev server origin", () => {
    const args = buildNotebookLaunch({
      tool: "jupyter",
      environment: {
        kind: "pi-lab",
        uvx: "/bin/uvx",
        label: "uvx",
        jupyterApp: "lab",
        fallbackReason: null,
      },
      cwd: "/repo",
      absPath: "/repo/a.ipynb",
      relPath: "a.ipynb",
      port: 42_700,
      token: "tok",
      devServerOrigin: "http://localhost:5173",
    }).args
    expect(args).toContain(
      `--ServerApp.tornado_settings={"headers":{"Content-Security-Policy":"frame-ancestors 'self' file: http://localhost:5173"}}`,
    )
  })

  test("a PI Lab copy of marimo runs the notebook in sandbox mode through uvx", () => {
    expect(
      buildNotebookLaunch({
        tool: "marimo",
        environment: {
          kind: "pi-lab",
          uvx: "/bin/uvx",
          label: "uvx",
          jupyterApp: null,
          fallbackReason: null,
        },
        cwd: "/repo",
        absPath: "/repo/nb.py",
        relPath: "nb.py",
        port: 42_701,
        token: "tok",
        devServerOrigin: null,
      }),
    ).toMatchObject({
      command: "/bin/uvx",
      args: [
        "marimo",
        "edit",
        "--sandbox",
        "/repo/nb.py",
        "--host",
        "127.0.0.1",
        "--port",
        "42701",
        "--headless",
        "--token-password",
        "tok",
      ],
    })
  })
})
