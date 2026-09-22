const weatherButton = document.getElementById("weather-button");
const weatherOutput = document.getElementById("weather-output");
const noteForm = document.getElementById("note-form");
const noteInput = document.getElementById("note-input");
const notesList = document.getElementById("notes-list");

async function loadWeather() {
  const response = await fetch("/api/weather");
  const data = await response.json();
  weatherOutput.textContent = JSON.stringify(data, null, 2);
}

async function loadNotes() {
  const response = await fetch("/api/notes");
  const data = await response.json();
  notesList.innerHTML = "";
  for (const note of data.notes) {
    const item = document.createElement("li");
    item.textContent = note.text;
    notesList.appendChild(item);
  }
}

async function addNote(text) {
  await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text }),
  });
  await loadNotes();
}

weatherButton.addEventListener("click", loadWeather);

noteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await addNote(noteInput.value);
  noteInput.value = "";
});

loadNotes();
