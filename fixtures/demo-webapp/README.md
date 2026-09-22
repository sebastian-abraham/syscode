# Demo Webapp

Install dependencies: `pip install -r requirements.txt`
Run the API: `uvicorn app.main:app --reload`
Set `OPENWEATHER_API_KEY` for real weather data and optionally `DB_PATH` for the notes database.
Open `web/index.html` in a browser to use the weather button and notes form.
The frontend calls `/api/weather` and `/api/notes` on the same origin serving the app.
