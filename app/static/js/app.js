// Fills the shared confirmation dialog from the button that opened it.
document.addEventListener("show.bs.modal", function (event) {
  var trigger = event.relatedTarget;
  if (!trigger || !trigger.dataset.actionUrl) { return; }
  var modal = event.target;
  modal.querySelector("form").setAttribute("action", trigger.dataset.actionUrl);
  modal.querySelector(".confirm-title").textContent = trigger.dataset.title || "Confirm";
  modal.querySelector(".confirm-message").textContent = trigger.dataset.message || "";
  var submit = modal.querySelector(".confirm-submit");
  var typedWrap = modal.querySelector(".confirm-typed-wrap");
  var typedInput = modal.querySelector(".confirm-typed-input");
  var confirmation = trigger.dataset.confirmText || "";
  typedWrap.classList.toggle("d-none", !confirmation);
  typedInput.value = "";
  typedInput.required = Boolean(confirmation);
  typedInput.dataset.expected = confirmation;
  modal.querySelector(".confirm-typed-label").textContent = confirmation
    ? "Type " + confirmation + " to confirm this action."
    : "";
  submit.disabled = Boolean(confirmation);
  submit.textContent = trigger.dataset.button || "Confirm";
});

document.addEventListener("input", function (event) {
  if (!event.target.matches(".confirm-typed-input")) { return; }
  var modal = event.target.closest(".modal");
  modal.querySelector(".confirm-submit").disabled = event.target.value.trim() !== event.target.dataset.expected;
});

document.addEventListener("submit", function (event) {
  if (!event.target.matches("#confirmModal form")) { return; }
  var input = event.target.querySelector(".confirm-typed-input");
  if (!input.dataset.expected) { return; }
  if (input.value.trim() !== input.dataset.expected) {
    event.preventDefault();
    event.target.querySelector(".confirm-submit").disabled = true;
  }
});

document.addEventListener("click", function (event) {
  var trigger = event.target.closest("[data-print-page]");
  if (trigger) {
    window.print();
  }
});
