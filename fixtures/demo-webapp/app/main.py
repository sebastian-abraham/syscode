import os

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import db

app = FastAPI(title="Demo Webapp")

WEATHER_API_URL = "https://api.openweathermap.org/data/2.5/weather"


class NoteIn(BaseModel):
    text: str


@app.get("/api/weather")
async def get_weather(city: str = "London"):
    params = {"q": city, "appid": os.environ.get("OPENWEATHER_API_KEY", "")}
    async with httpx.AsyncClient() as client:
        response = await client.get(WEATHER_API_URL, params=params)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=response.text)
    return response.json()


@app.post("/api/notes")
def create_note(note: NoteIn):
    note_id = db.save_note(note.text)
    return {"id": note_id, "text": note.text}


@app.get("/api/notes")
def get_notes():
    return {"notes": db.list_notes()}
