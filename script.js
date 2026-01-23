document.getElementById("bookingForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  alert("Got it — we’ll text/email you 3 appointment options shortly.");
  e.target.reset();
});

document.getElementById("existingJobForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  alert("Thanks — we received your job reference. We’ll follow up by text/email.");
  e.target.reset();
});
