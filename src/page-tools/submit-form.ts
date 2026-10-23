// ─── submit-form ─────────────────────────────────────────────────────
// Submit a form for the agent's submit_form tool and report exactly one
// outcome: `form_submitted`, `form_submit_blocked` or
// `form_submit_uncertain`. The worker waits up to 6 s for it.
//
// Ported from the `submit_form` branch of @livelayer/react 0.26.0's
// AvatarWidget.tsx handleDataMessage (github.com/Fusion-Studios-Code/
// live-layer-react @ a0ac539). Same checks, same timings, same reason
// codes, with one fix: while watching an SPA submit, a required field
// that is empty only because the page cleared it is not a validation
// error (see collectInvalid).
//
// Outcomes:
//   - native HTML5 constraints unmet before submitting → blocked
//     (reason "validation", invalidFields "<label>: <message>"); the
//     form is not submitted.
//   - the submit event fires and nothing prevents it (a real POST /
//     navigation) → submitted.
//   - the submit event fires and the page's handler calls
//     preventDefault() (SPA / framework form, sent with fetch): the form
//     is watched for about 2 s and the first decisive signal wins:
//       validation errors appear      → blocked ("validation"), not
//                                       counting required fields the
//                                       page emptied
//       the form leaves the DOM       → submitted ("form_removed")
//       every filled field is cleared → submitted ("form_reset")
//       a success message appears     → submitted ("success_text")
//       nothing decisive              → uncertain ("spa_prevented")
//     A rejected form keeps its values and shows errors; only a
//     successful one clears, so a cleared form is a reliable success.
//   - requestSubmit() throws → blocked ("exception").
//   - the submit event never fires within 500 ms → blocked ("validation").

type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** First check of an SPA-handled submit, after the page's own handler has had a moment. */
export const SPA_FIRST_CHECK_MS = 200;
/** Interval between later checks. */
export const SPA_POLL_MS = 250;
/** How long an SPA-handled submit is watched before it is reported as uncertain. */
export const SPA_OBSERVE_MS = 2000;
/** A submit event that has not fired by now was suppressed (constraint validation). */
export const SUBMIT_EVENT_WAIT_MS = 500;

const SUCCESS_RE =
  /(thank you|thanks|we'?ll be in touch|message sent|message has been sent|successfully|submission received|got your message|we received|talk soon|be in touch)/i;

const NON_FILLABLE_INPUT_TYPES = ["hidden", "submit", "button", "reset", "file", "image"];

function isFillable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    return !NON_FILLABLE_INPUT_TYPES.includes(((el as HTMLInputElement).type || "text").toLowerCase());
  }
  return false;
}

function valueOf(el: Element): string {
  const inp = el as HTMLInputElement;
  if (el.tagName.toLowerCase() === "input" && (inp.type === "checkbox" || inp.type === "radio")) {
    return inp.checked ? "on" : "";
  }
  return (inp.value || "").trim();
}

export type SubmitOutcome = Record<string, unknown> & {
  type: "form_submitted" | "form_submit_blocked" | "form_submit_uncertain";
  formId: string;
};

/**
 * Submit `form` and call `reply` exactly once with the outcome. `formId`
 * is echoed as the agent sent it.
 */
export function submitForm(
  form: HTMLFormElement,
  formId: string,
  reply: (outcome: SubmitOutcome) => void,
): void {
  // Names of fields failing native validation, so the agent can name
  // the offending field instead of guessing.
  const fieldLabel = (el: Element): string => {
    const al = el.getAttribute("aria-label");
    if (al) return al;
    const id = (el as HTMLElement).id;
    if (id) {
      const lab = form.ownerDocument.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
      if (lab?.textContent?.trim()) return lab.textContent.trim();
    }
    return el.getAttribute("name") || id || (el as HTMLInputElement).type || "field";
  };
  // `afterSubmit`: ignore a field that is invalid only because it is now
  // empty. The pre-check below guarantees no required field was empty
  // at submit time, so an empty required field afterwards means the page
  // cleared it, which is what a successful send does. (React counts it
  // as a validation failure, so a `required` form that resets after a
  // successful SPA submit is reported as blocked.)
  const collectInvalid = (afterSubmit = false): string[] => {
    try {
      return Array.from(form.elements)
        .filter((el) => {
          const c = el as FormControl;
          if (!("willValidate" in el) || !c.willValidate || c.checkValidity()) return false;
          return !(afterSubmit && c.validity?.valueMissing && !c.validity.customError);
        })
        .map((el) => `${fieldLabel(el)}: ${(el as FormControl).validationMessage}`);
    } catch {
      return [];
    }
  };

  let resolved = false;
  const resolveOnce = (outcome: SubmitOutcome) => {
    if (resolved) return;
    resolved = true;
    reply(outcome);
  };
  const blocked = (reason: string, invalidFields: string[] = []) =>
    resolveOnce({ type: "form_submit_blocked", formId, reason, invalidFields });

  // HTML5 pre-check: unmet native constraints are reported by name and
  // the form is NOT submitted. (A JS-validated form passes this; the
  // defaultPrevented watch below is what catches it.)
  if (typeof form.checkValidity === "function" && !form.checkValidity()) {
    try {
      form.reportValidity?.();
    } catch {
      /* best effort */
    }
    blocked("validation", collectInvalid());
    return;
  }

  // Which fields had values, and the text around the form, BEFORE the
  // submit, to recognise a reset or a success message afterwards.
  const filledBefore = Array.from(form.elements).filter(
    (el) => isFillable(el) && valueOf(el).length > 0,
  );
  const containerTextBefore = (form.parentElement?.textContent || "").toLowerCase();

  const observeSpaOutcome = () => {
    const start = Date.now();
    const tick = () => {
      if (resolved) return;
      const invalid = collectInvalid(true);
      if (invalid.length > 0) {
        blocked("validation", invalid);
        return;
      }
      if (!form.isConnected) {
        resolveOnce({ type: "form_submitted", formId, reason: "form_removed" });
        return;
      }
      if (filledBefore.length > 0 && filledBefore.every((el) => valueOf(el).length === 0)) {
        resolveOnce({ type: "form_submitted", formId, reason: "form_reset" });
        return;
      }
      const after = (form.parentElement?.textContent || "").toLowerCase();
      if (SUCCESS_RE.test(after) && !SUCCESS_RE.test(containerTextBefore)) {
        resolveOnce({ type: "form_submitted", formId, reason: "success_text" });
        return;
      }
      if (Date.now() - start < SPA_OBSERVE_MS) {
        setTimeout(tick, SPA_POLL_MS);
      } else {
        resolveOnce({ type: "form_submit_uncertain", formId, reason: "spa_prevented" });
      }
    };
    setTimeout(tick, SPA_FIRST_CHECK_MS);
  };

  let fired = false;
  const onSubmit = (e: Event) => {
    fired = true;
    // Read defaultPrevented after every listener has run: a framework's
    // delegated handler (React's root listener) calls preventDefault()
    // after this one.
    queueMicrotask(() => {
      if (e.defaultPrevented) {
        observeSpaOutcome();
      } else {
        resolveOnce({ type: "form_submitted", formId });
      }
    });
  };
  form.addEventListener("submit", onSubmit, { once: true });
  try {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }
  } catch (err) {
    console.warn("[LiveLayer] submit_form: requestSubmit threw.", err);
    form.removeEventListener("submit", onSubmit);
    blocked("exception");
    return;
  }
  setTimeout(() => {
    if (!fired && !resolved) {
      form.removeEventListener("submit", onSubmit);
      blocked("validation", collectInvalid());
    }
  }, SUBMIT_EVENT_WAIT_MS);
}
