import { fireEvent, render, screen, within } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { ProjectPicker } from "./ProjectPicker"

const projects = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta" },
]

function renderPicker(value: string, allLabel: string | null, onChange: (id: string) => void) {
  render(
    <ProjectPicker
      testId="demo-project-select"
      label="Demo project"
      help="Pick a project"
      value={value}
      projects={projects}
      allLabel={allLabel}
      onChange={onChange}
    />,
  )
  return screen.getByTestId("demo-project-select")
}

test("the closed picker shows the chosen project; a click lists the projects and picks one", () => {
  const onChange = vi.fn()
  const trigger = renderPicker("p1", null, onChange)
  expect(trigger.tagName).toBe("BUTTON")
  expect(trigger).toHaveProperty("value", "p1")
  expect(trigger.textContent).toBe("Alpha")
  expect(trigger.getAttribute("aria-label")).toBe("Demo project")
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByRole("listbox")).toBeNull()

  fireEvent.click(trigger)
  const list = screen.getByRole("listbox", { name: "Demo project" })
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  const options = within(list).getAllByRole("option")
  expect(options.map((option) => option.textContent)).toEqual(["Alpha", "Beta"])
  expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"])

  fireEvent.click(within(list).getByRole("option", { name: "Beta" }))
  expect(onChange).toHaveBeenCalledWith("p2")
  expect(screen.queryByRole("listbox")).toBeNull()
})

test("an All projects entry comes first and stands for the empty value", () => {
  const onChange = vi.fn()
  const trigger = renderPicker("", "All projects", onChange)
  expect(trigger.textContent).toBe("All projects")
  fireEvent.click(trigger)
  const options = screen.getAllByRole("option")
  expect(options.map((option) => option.textContent)).toEqual(["All projects", "Alpha", "Beta"])
  fireEvent.click(screen.getByRole("option", { name: "Alpha" }))
  expect(onChange).toHaveBeenCalledWith("p1")
})

test("the keyboard opens the list, moves through it, picks with Enter and closes with Escape", () => {
  const onChange = vi.fn()
  const trigger = renderPicker("p1", null, onChange)
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  expect(screen.getByRole("listbox")).toBeTruthy()
  // The chosen project is highlighted first; ArrowDown moves to the next one.
  const active = () => document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")
  expect(active()?.textContent).toBe("Alpha")
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  expect(active()?.textContent).toBe("Beta")
  fireEvent.keyDown(trigger, { key: "ArrowUp" })
  expect(active()?.textContent).toBe("Alpha")
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  fireEvent.keyDown(trigger, { key: "Enter" })
  expect(onChange).toHaveBeenCalledWith("p2")
  expect(screen.queryByRole("listbox")).toBeNull()

  fireEvent.keyDown(trigger, { key: " " })
  expect(screen.getByRole("listbox")).toBeTruthy()
  fireEvent.keyDown(window, { key: "Escape" })
  expect(screen.queryByRole("listbox")).toBeNull()
  fireEvent.keyDown(trigger, { key: "Enter" })
  expect(screen.getByRole("listbox")).toBeTruthy()
  fireEvent.mouseDown(document.body)
  expect(screen.queryByRole("listbox")).toBeNull()
  expect(onChange).toHaveBeenCalledTimes(1)
})
