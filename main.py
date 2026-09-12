import json, os, re
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()
app=FastAPI(title='GramUdyam AI API')
app.add_middleware(CORSMiddleware,allow_origins=['*'],allow_credentials=False,allow_methods=['*'],allow_headers=['*'])

class Request(BaseModel): transcript:str

SCHEMA='''Return ONLY valid JSON with exactly two top-level objects: intake and report. intake fields: name, business_type, location, monthly_income, savings, estimated_investment, existing_debt, loan_required, extra. report fields: business_name, feasibility, demand, competition, profit_potential (0-5 integer), pricing_strategy, summary, estimated_investment, recommended_loan, risks (array of strings), recommendations (array of strings). Use null or 0 when a number is unknown. Do not invent personal facts. You may provide clearly-labelled business estimates/recommendations based on the stated facts and general reasoning.'''

@app.get('/health')
def health(): return {'ok':True}

@app.post('/analyze-business')
async def analyze(req:Request):
    key=os.getenv('GEMINI_API_KEY'); model=os.getenv('GEMINI_MODEL','gemini-2.5-flash')
    if not key: raise HTTPException(500,'GEMINI_API_KEY is not configured')
    prompt=f'''You are GramUdyam, a practical rural/small-business advisor. The user may speak Hindi, Hinglish, Marathi, or English. Understand the meaning even when grammar is informal. Extract every useful detail from the user's single spoken message, then create a concise business feasibility report. Never claim certainty about market facts you cannot verify. {SCHEMA}\n\nUSER MESSAGE:\n{req.transcript}'''
    url=f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}'
    body={'contents':[{'parts':[{'text':prompt}]}],'generationConfig':{'temperature':0.2,'responseMimeType':'application/json'}}
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r=await client.post(url,json=body); r.raise_for_status(); data=r.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(502,f'Gemini error: {e.response.text[:1000]}')
    except Exception as e: raise HTTPException(502,f'Gemini request failed: {e}')
    try:
        text=data['candidates'][0]['content']['parts'][0]['text']
        text=re.sub(r'^```json\s*|\s*```$','',text.strip(),flags=re.I)
        parsed=json.loads(text)
    except Exception as e: raise HTTPException(502,f'Could not parse Gemini JSON: {e}')
    return parsed
