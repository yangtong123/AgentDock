import { ASSIGNABLE_STEPS, QUICK_COMBOS, comboAssignment, type ProviderAssignment, type QuickCombo } from "../lib/providers";

/**
 * Per-step provider assignment with quick combos. Quick combos are presets over
 * the same map; after choosing one, every step stays editable (Custom).
 */
export function ProviderAssignmentEditor({
  providers,
  value,
  onChange,
}: {
  providers: string[];
  value: ProviderAssignment;
  onChange: (next: ProviderAssignment) => void;
}) {
  return (
    <div className="assignment-editor">
      <div className="combos">
        {QUICK_COMBOS.map((combo) => (
          <button key={combo.id} type="button" className="chip" onClick={() => onChange(comboAssignment(combo.id as QuickCombo))}>
            {combo.label}
          </button>
        ))}
        <span className="chip static">Custom ↓</span>
      </div>
      <div className="assignment-grid">
        {ASSIGNABLE_STEPS.map((step) => (
          <label key={step} className="assignment-row">
            <span className="mono small">{step}</span>
            <select
              value={value[step] ?? ""}
              onChange={(event) => onChange({ ...value, [step]: event.target.value })}
            >
              {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
            </select>
          </label>
        ))}
        <label className="assignment-row">
          <span className="mono small dim">HUMAN_APPROVAL</span>
          <span className="small dim">human (fixed)</span>
        </label>
      </div>
    </div>
  );
}
