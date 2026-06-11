"""One-shot smoke test: run the ADK agent against a live query.

Spawns the MongoDB MCP server, queries Atlas, and prints Gemini's recommendation.
Run from the repo root:  agent/.venv/bin/python agent/smoke_test.py "your task"
"""
import asyncio
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "clawmatcher", ".env"))
sys.path.insert(0, os.path.dirname(__file__))

from clawmatcher.agent import root_agent  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai import types  # noqa: E402

APP = "clawmatcher"


async def ask(query: str) -> None:
    session_service = InMemorySessionService()
    runner = Runner(agent=root_agent, app_name=APP, session_service=session_service)
    await session_service.create_session(app_name=APP, user_id="demo", session_id="s1")
    msg = types.Content(role="user", parts=[types.Part(text=query)])

    tool_calls = []
    final = None
    async for event in runner.run_async(user_id="demo", session_id="s1", new_message=msg):
        for part in (event.content.parts if event.content else []) or []:
            if getattr(part, "function_call", None):
                tool_calls.append(part.function_call.name)
        if event.is_final_response() and event.content:
            final = "".join(p.text or "" for p in event.content.parts)

    print(f"\nQUERY: {query}")
    print(f"MCP tool calls: {tool_calls}")
    print("--- agent reply ---")
    print(final)


if __name__ == "__main__":
    q = sys.argv[1] if len(sys.argv) > 1 else "I need a blockchain project audit."
    asyncio.run(ask(q))
    # ADK's stdio MCP session can hang on interpreter shutdown in a one-shot
    # script (it's fine under `adk api_server`, which keeps the session open).
    # Force a clean exit now that we have the answer.
    os._exit(0)
