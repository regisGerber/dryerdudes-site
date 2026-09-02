import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Admin delete tool could not load because Supabase config is missing.");
} else {
  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  function injectPanel() {
    const page = document.querySelector(".page");
    const header = page?.querySelector(".site-header");
    if (!page || !header || document.getElementById("adminDeleteJobPanel")) return;

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.id = "adminDeleteJobPanel";
    panel.innerHTML = `
      <div class="row">
        <div>
          <h3>Delete a job</h3>
          <div class="subtext">
            Permanently deletes an unpaid booking and its related billing, parts, and event records, then reopens the schedule slot. Paid jobs are blocked from deletion.
          </div>
        </div>
      </div>
      <div class="seg" style="align-items:flex-end; margin-top:10px;">
        <label style="display:flex; flex-direction:column; gap:6px; min-width:230px; flex:1;">
          <span class="tiny">Exact job reference</span>
          <input id="adminDeleteJobRef" type="text" placeholder="DD-123456" autocomplete="off" />
        </label>
        <button
          id="adminDeleteJobBtn"
          class="btn secondary"
          type="button"
          style="border-color:rgba(255,80,120,.55); color:#ffd6e5;"
        >
          Delete job permanently
        </button>
      </div>
      <div id="adminDeleteJobMessage" class="tiny" style="margin-top:10px; white-space:pre-line;"></div>
    `;

    header.insertAdjacentElement("afterend", panel);

    const input = panel.querySelector("#adminDeleteJobRef");
    const button = panel.querySelector("#adminDeleteJobBtn");
    const message = panel.querySelector("#adminDeleteJobMessage");

    input.addEventListener("input", () => {
      input.value = input.value.toUpperCase().replace(/\s+/g, "");
    });

    button.addEventListener("click", async () => {
      const jobRef = String(input.value || "").trim().toUpperCase();

      if (!/^DD-\d{6}$/.test(jobRef)) {
        message.textContent = "Enter the complete job reference in the format DD-123456.";
        return;
      }

      const firstConfirm = window.confirm(
        `Permanently delete ${jobRef}?\n\nThis removes the booking and related operational records and reopens its schedule slot. This cannot be undone.`
      );

      if (!firstConfirm) return;

      const typed = window.prompt(
        `Type ${jobRef} to confirm permanent deletion:`
      );

      if (String(typed || "").trim().toUpperCase() !== jobRef) {
        message.textContent = "Deletion canceled because the confirmation did not match.";
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        message.textContent = "Your admin session has expired. Sign in again.";
        return;
      }

      button.disabled = true;
      message.textContent = `Deleting ${jobRef}…`;

      try {
        const response = await fetch("/api/admin-delete-job", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            job_ref: jobRef,
            confirm_job_ref: jobRef,
          }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data?.ok) {
          throw new Error(data?.message || data?.error || "Could not delete the job.");
        }

        const requestNote = data.request_deleted
          ? "The linked request was also deleted."
          : "The linked request was retained as canceled.";

        message.textContent =
          `${jobRef} was deleted. Its schedule slot was reopened. ${requestNote}\nRefreshing the admin portal…`;

        window.setTimeout(() => window.location.reload(), 1400);
      } catch (error) {
        console.error(error);
        message.textContent = error?.message || "Could not delete the job.";
        button.disabled = false;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectPanel, { once: true });
  } else {
    injectPanel();
  }
}
