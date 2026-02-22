import os
import asyncio
import logging
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import google.generativeai as genai
import httpx
import sqlite3
from datetime import datetime

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load .env
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)

GEMINI_KEY = os.getenv("GEMINI_API_KEY")
TAVILY_KEY = os.getenv("TAVILY_API_KEY")

# Configure Gemini SDK
if not GEMINI_KEY:
    logger.error("GEMINI_API_KEY not found in .env")
else:
    genai.configure(api_key=GEMINI_KEY)

# -------- Database Setup --------
import tempfile
DB_DIR = Path(tempfile.gettempdir()) / "chaka_data"
DB_DIR.mkdir(exist_ok=True)
DB_PATH = DB_DIR / "chaka.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    # Table for content generations
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS generations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company TEXT,
            focus TEXT,
            platform TEXT,
            model TEXT,
            research_data TEXT,
            generated_content TEXT,
            virality_score INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Table for chat history
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT,
            response TEXT,
            context TEXT,
            selection TEXT,
            model TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

init_db()

def save_generation(data, content, score):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO generations (company, focus, platform, model, research_data, generated_content, virality_score)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            data.get("company"),
            data.get("focus"),
            data.get("platform"),
            data.get("model", "gemini-2.5-flash"),
            str(data.get("research_results", "")),
            content,
            score
        ))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Error saving generation: {e}")

def save_chat(message, response, context, selection, model):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO chats (message, response, context, selection, model)
            VALUES (?, ?, ?, ?, ?)
        """, (message, response, context, selection, model))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Error saving chat: {e}")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files (script.js, style.css) from the project root
# Note: In production on Render, the root is /opt/render/project/src
root_dir = Path(__file__).parent.parent
app.mount("/static", StaticFiles(directory=str(root_dir)), name="static")

@app.get("/")
async def read_root():
    return FileResponse(root_dir / "rcode.html")

# -------- Web research (Async with Tavily + Serper) --------
SERPER_API_KEY = os.getenv("SERPER_API_KEY")

async def tavily_search(query):
    if not TAVILY_KEY: return []
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                "https://api.tavily.com/search",
                json={"api_key": TAVILY_KEY, "query": query, "search_depth": "advanced", "max_results": 5},
                timeout=10.0
            )
            data = res.json()
            return [{"title": r["title"], "url": r["url"], "snippet": r["content"], "source": "tavily"} for r in data.get("results", [])]
    except Exception as e:
        logger.error(f"Tavily error: {e}")
        return []

async def serper_search(query):
    if not SERPER_API_KEY:
        logger.warning("Serper API Key missing.")
        return []
    try:
        logger.info(f"Querying Serper for: {query}")
        async with httpx.AsyncClient() as client:
            res = await client.post(
                "https://google.serper.dev/search",
                headers={"X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json"},
                json={"q": query, "num": 5},
                timeout=10.0
            )
            logger.info(f"Serper Response Status: {res.status_code}")
            data = res.json()
            results = [{"title": r.get("title"), "url": r.get("link"), "snippet": r.get("snippet"), "source": "serper"} for r in data.get("organic", [])]
            logger.info(f"Serper found {len(results)} results")
            return results
    except Exception as e:
        logger.error(f"Serper error: {e}")
        return []

async def web_research(query):
    logger.info(f"Starting async research for: {query}")
    try:
        # Run both in parallel
        results = await asyncio.gather(tavily_search(query), serper_search(query))
        
        # Flatten and deduplicate
        combined = []
        seen_urls = set()
        
        for engine_res in results:
            for r in engine_res:
                if r['url'] not in seen_urls:
                    combined.append(r)
                    seen_urls.add(r['url'])
        
        return combined[:10]
    except Exception as e:
        logger.error(f"Research failed: {e}")
        return []
        logger.info(f"Research found {len(sources)} sources")
        return sources
    except Exception as e:
        logger.error(f"Research failed: {e}")
        return []

# -------- Main endpoint --------
@app.post("/generate")
async def generate(req: Request):
    data = await req.json()
    logger.info(f"Received request: {data}")

    company = data.get("company", "")
    focus = data.get("focus", "")
    days = data.get("days", "3")
    length = data.get("length", "Medium")
    platform = data.get("platform", "LinkedIn")
    user_location = data.get("user_location")
    # Default to user requested model, let SDK handle errors if invalid
    model_name = data.get("model", "gemini-2.5-flash")

    # Perform research
    research_results = await web_research(f"{company} {platform} content strategy {focus}")

    research_text = ""
    for s in research_results:
        research_text += f"- {s['title']} ({s['url']}): {s['snippet']}\n"

    # Platform DNA Prompts
    platform_instructions = {
        "LinkedIn": """
            STYLE: "Broetry" / Authority Leader.
            - Short, punchy paragraphs (1-2 sentences max).
            - Use whitespace aggressively.
            - Professional but personal tone.
            - Focus on "Lessons Learned", "Industry Myths", or "Future Trends".
            - NO hashtags in the middle of text. 3-5 hashtags at the very end.
        """,
        "Twitter": """
            STYLE: Viral Thread / Thought Leader.
            - First line MUST be a scroll-stopping hook (no generic intros).
            - Use 🧵 emoji for thread indication.
            - Each point is a separate tweet (max 280 chars).
            - Aggressive, opinionated, high-signal.
            - Use bullet points and arrows (→).
        """,
        "Instagram": """
            STYLE: Visual Storyteller / Influencer.
            - Focus on the visual description first (what should the image/video be?).
            - Caption is emotional and engaging.
            - Use line breaks.
            - Call to Action: "Double tap if you agree", "Link in bio".
            - Block of 30 relevant hashtags at the bottom.
        """,
        "Blog": """
            STYLE: SEO Optimized / Long-form.
            - H1, H2, H3 hierarchy.
            - Clear introduction, body, and conclusion.
            - Keyword rich.
            - Professional and educational.
        """
    }

    selected_instruction = platform_instructions.get(platform, platform_instructions["LinkedIn"])

    current_time = datetime.now().strftime("%A, %B %d, %Y, %I:%M %p")
    location = user_location if user_location else "Lagos, Nigeria"

    prompt = f"""
    Act as the **R-Code Media manager**, an elite AI Content Strategy Engine powered by **Chaka**.
    R-Code Media is led by CEO **Matthew Kingsly Ukwa**.
    
    ENVIRONMENT:
    - Current Date & Time: {current_time}
    - Location: {location}
    
    Target: {company}
    Focus: {focus}
    Platform: {platform}
    Timeline: {days} Days
    Content Depth: {length}

    RESEARCH DATA:
    {research_text}

    Create a high-impact content calendar.
    For EACH post, include:
    - Day/Date
    - Hook/Headline
    - Content Strategy (Why this works?)
    - Platform Specific Format (e.g. Carousel for LinkedIn, Thread for X, Reel for IG)
    - Full Content Draft

    CRITICAL INSTRUCTION:
    First, analyze the strategy and assign a 'VIRALITY SCORE' from 0-100 based on current trends.
    Output this score strictly as: [VIRALITY_SCORE: 85]

    Then, provide the calendar and content.
    """

    async def stream_generator():
        try:
            # 1. Send Research Data First (Special Format)
            # We use a custom tag [SOURCES_START]...[SOURCES_END]
            if research_results:
                import json
                sources_json = json.dumps(research_results)
                yield f"[SOURCES_START]{sources_json}[SOURCES_END]"

            # 2. Stream Content
            model = genai.GenerativeModel(model_name)
            response = await model.generate_content_async(prompt, stream=True)
            
            full_content = ""
            virality_score = 0

            async for chunk in response:
                if chunk.text:
                   text = chunk.text
                   full_content += text
                   # Try to extract virality score if present
                   if "[VIRALITY_SCORE:" in text:
                       try:
                           score_part = text.split("[VIRALITY_SCORE:")[1].split("]")[0].strip()
                           virality_score = int(score_part)
                       except:
                           pass
                   yield text

            # Save to DB after streaming completes
            data["research_results"] = research_results
            save_generation(data, full_content, virality_score)

        except Exception as e:
            logger.error(f"Gemini SDK Error: {e}")
            yield f"Error generating content: {str(e)}\n\n(Tip: Valid models are gemini-1.5-flash, gemini-1.5-pro, gemini-2.0-flash-exp)"

    return StreamingResponse(stream_generator(), media_type="text/plain")

# -------- Chat / Rework Endpoint --------
@app.post("/chat")
async def chat(req: Request):
    data = await req.json()
    message = data.get("message", "")
    context = data.get("context", "") # Current document text
    selection = data.get("selection", "") # Selected text to rework
    user_location = data.get("user_location")
    model_name = data.get("model", "gemini-2.5-flash")
    
    logger.info(f"Chat request: {message[:50]}... | Selection: {bool(selection)}")

    # Construct Prompt
    if selection:
        # Contextual Rework Mode
        system_instruction = """
        You are an expert editor. 
        Your task is to REWRITE the 'Selection' based on the 'User Instruction'.
        
        RULES:
        1. Output ONLY the rewritten text. No conversational filler ("Here is the rewrite...").
        2. Maintain the voice and tone of the original context.
        3. Do not change the meaning unless instructed.
        """
        user_prompt = f"""
        CONTEXT:
        {context}
        
        SELECTION TO REWRITE:
        {selection}
        
        USER INSTRUCTION:
        {message}
        """
    else:
        # General Chat Mode
        current_time = datetime.now().strftime("%A, %B %d, %Y, %I:%M %p")
        location = user_location if user_location else "Lagos, Nigeria"
        
        system_instruction = f"""
        You are the **R-Code Media manager**, powered by the proprietary intelligence **Chaka**. 
        R-Code Media is founded and led by CEO **Matthew Kingsly Ukwa**.
        
        ENVIRONMENT:
        - Current Date & Time: {current_time}
        - Location: {location}
        
        IDENTITY RULES:
        1. When asked who you are, what your name is, or who owns/leads the company, identify as the **R-Code Media manager** and mention CEO **Matthew Kingsly Ukwa**.
        2. Information about your technical development (developed and trained by **Jomiez** under the leadership of **Templeton**) should ONLY be shared if the user specifically asks about your technical origins, who trained you, or how you were made.
        3. You are an elite AI Content Strategist. Be concise, professional, and helpful.
        """
        user_prompt = f"""
        CURRENT STRATEGY CONTEXT:
        {context}
        
        USER MESSAGE:
        {message}
        """

    async def stream_chat():
        try:
            model = genai.GenerativeModel(model_name, system_instruction=system_instruction)
            response = await model.generate_content_async(user_prompt, stream=True)
            full_response = ""
            async for chunk in response:
                if chunk.text:
                    full_response += chunk.text
                    yield chunk.text
            
            # Save to DB
            save_chat(message, full_response, context, selection, model_name)

        except Exception as e:
            logger.error(f"Chat Error: {e}")
            yield f"Error: {str(e)}"

    return StreamingResponse(stream_chat(), media_type="text/plain")

# -------- Export SQL Endpoint --------
@app.get("/export-sql")
async def export_sql():
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        sql_output = "-- Chaka AI Data Export\n"
        sql_output += "-- Standard ANSI SQL compatible\n\n"
        
        # Schema
        sql_output += """CREATE TABLE IF NOT EXISTS generations (
    id SERIAL PRIMARY KEY,
    company TEXT,
    focus TEXT,
    platform TEXT,
    model TEXT,
    research_data TEXT,
    generated_content TEXT,
    virality_score INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);\n\n"""

        sql_output += """CREATE TABLE IF NOT EXISTS chats (
    id SERIAL PRIMARY KEY,
    message TEXT,
    response TEXT,
    context TEXT,
    selection TEXT,
    model TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);\n\n"""

        # Generations
        cursor.execute("SELECT * FROM generations")
        for row in cursor.fetchall():
            cols = ["company", "focus", "platform", "model", "research_data", "generated_content", "virality_score"]
            vals = [row[c] for c in cols]
            vals_str = ", ".join(["'{}'".format(str(v).replace("'", "''")) if v is not None else "NULL" for v in vals])
            sql_output += f"INSERT INTO generations ({', '.join(cols)}) VALUES ({vals_str});\n"
            
        sql_output += "\n"

        # Chats
        cursor.execute("SELECT * FROM chats")
        for row in cursor.fetchall():
            cols = ["message", "response", "context", "selection", "model"]
            vals = [row[c] for c in cols]
            vals_str = ", ".join(["'{}'".format(str(v).replace("'", "''")) if v is not None else "NULL" for v in vals])
            sql_output += f"INSERT INTO chats ({', '.join(cols)}) VALUES ({vals_str});\n"

        conn.close()
        return StreamingResponse(iter([sql_output]), media_type="text/plain")
    except Exception as e:
        logger.error(f"Export Error: {e}")
        return {"error": str(e)}
