import {
  type QuickEditorMarkdownMode,
  useEditorVimCache,
  useQuickEditorAutocomplete,
  useQuickEditorMarkdownMode,
  useQuickEditorRunPython,
  writeEditorVimChoice,
} from "../../../../preferences/preferences"
import { SelectField, SettingsSection, ToggleField } from "./SettingsControls"

/** Preferences shared by the quick renderer and the full app's Editor page. */
export function QuickEditorSection() {
  const [vim] = useEditorVimCache()
  const [autocomplete, setAutocomplete] = useQuickEditorAutocomplete()
  const [markdownMode, setMarkdownMode] = useQuickEditorMarkdownMode()
  const [runPython, setRunPython] = useQuickEditorRunPython()

  return (
    <SettingsSection
      testId="settings-section-quick-editor"
      title="Quick Editor"
      description="Choose how Quick Editor works when you open a file."
    >
      <ToggleField
        testId="settings-quick-editor-vim"
        label="Vim mode"
        description="Use the same Vim choice in Quick Editor and the full editor."
        checked={vim}
        onChange={writeEditorVimChoice}
      />
      <ToggleField
        testId="settings-quick-editor-autocomplete"
        label="Word autocomplete"
        description="Suggest words already in the open file."
        checked={autocomplete}
        onChange={setAutocomplete}
      />
      <SelectField
        testId="settings-quick-editor-markdown-view"
        label="Default Markdown view"
        description="Open Markdown as source text or rendered text."
        value={markdownMode}
        options={[
          { value: "source", label: "Source" },
          { value: "render", label: "Render" },
        ]}
        onChange={(value) => setMarkdownMode(value as QuickEditorMarkdownMode)}
      />
      <ToggleField
        testId="settings-quick-editor-run-python"
        label="Run Python"
        description="Show a Python environment picker and run files in a terminal below Quick Editor."
        checked={runPython}
        onChange={setRunPython}
      />
    </SettingsSection>
  )
}
