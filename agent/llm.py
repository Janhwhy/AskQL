"""LLM wrapper: Gemini primary, Ollama (local) fallback.

User's explicit choice, 2026-09-20. Falls back on ANY Gemini failure (missing
key, network error, API-blocked project, quota) so a bad Gemini day doesn't
take the agent down — never silently returns nothing, always tries Ollama
before giving up.
"""

import logging
import os

import httpx

logger = logging.getLogger("askql.agent")

GEMINI_MODEL = "gemini-3.6-flash"
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5-coder:7b")


def _call_gemini(prompt: str) -> str:
    from google import genai  # imported lazily — Ollama-only setups shouldn't need this installed working

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
    if not response.text:
        raise RuntimeError("Gemini returned an empty response")
    return response.text


def _call_ollama(prompt: str) -> str:
    r = httpx.post(
        f"{OLLAMA_HOST}/api/generate",
        json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
        timeout=60.0,
    )
    r.raise_for_status()
    text = r.json().get("response", "")
    if not text:
        raise RuntimeError("Ollama returned an empty response")
    return text


def generate(prompt: str) -> str:
    """Returns raw LLM text. Caller is responsible for parsing/validating it
    (see agent/validation.py for the SQL-specific check)."""
    try:
        return _call_gemini(prompt)
    except Exception as e:
        logger.warning("Gemini failed (%s), falling back to Ollama (%s)", e, OLLAMA_MODEL)
        return _call_ollama(prompt)
