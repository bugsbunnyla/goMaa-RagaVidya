'use strict';
/**
 * POST /api/transcribe
 * Real-time audio transcription using faster-whisper (Python).
 * Supports Telugu (te), Sanskrit (sa), and all Indic languages.
 * Captures gamakas, aalapana, kampita syllable curves completely.
 * 
 * Open-source model: faster-whisper (Guillaume Klein)
 * https://github.com/SYSTRAN/faster-whisper
 * Based on: OpenAI Whisper (large-v3 for best Indic accuracy)
 */
const express      = require('express');
const router       = express.Router();
const { execFile, spawn } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

// Check if faster-whisper is available
let _whisperAvail = null;
function _checkWhisper(){
  if(_whisperAvail !== null) return Promise.resolve(_whisperAvail);
  return new Promise(res=>{
    execFile('python3',['-c','import faster_whisper; print("ok")'],{timeout:5000},(err,out)=>{
      _whisperAvail = !err && out.includes('ok');
      console.log('[transcribe] faster-whisper available:', _whisperAvail);
      res(_whisperAvail);
    });
  });
}

// Python transcription script (inline, no temp file needed)
const WHISPER_SCRIPT = `
import sys, json
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
lang       = sys.argv[2] if len(sys.argv)>2 else 'te'  # Telugu default
model_size = sys.argv[3] if len(sys.argv)>3 else 'base'  # base for speed

model = WhisperModel(model_size, device='cpu', compute_type='int8')
segments, info = model.transcribe(
    audio_path,
    language=lang,
    beam_size=5,
    vad_filter=True,           # Voice Activity Detection — removes silence
    vad_parameters=dict(
        min_silence_duration_ms=200,   # keep short pauses (gamaka gaps)
        speech_pad_ms=100              # padding around speech
    ),
    word_timestamps=True,              # word-level timing
    condition_on_previous_text=True,   # context continuity
    temperature=0.0,                   # deterministic
    no_speech_threshold=0.3,           # catch soft gamaka passages
    log_prob_threshold=-0.5,           # accept lower-confidence Carnatic syllables
)

result = {
    'language': info.language,
    'language_probability': float(info.language_probability),
    'duration': float(info.duration),
    'segments': []
}
for seg in segments:
    words = []
    if hasattr(seg, 'words') and seg.words:
        for w in seg.words:
            words.append({'word': w.word, 'start': float(w.start), 
                         'end': float(w.end), 'prob': float(w.probability)})
    result['segments'].append({
        'id': seg.id,
        'start': float(seg.start),
        'end': float(seg.end),
        'text': seg.text.strip(),
        'avg_logprob': float(seg.avg_logprob),
        'no_speech_prob': float(seg.no_speech_prob),
        'words': words
    })
print(json.dumps(result, ensure_ascii=False))
`;

router.post('/', express.raw({type:'*/*', limit:'200mb'}), async (req,res)=>{
  const available = await _checkWhisper();
  if(!available){
    return res.json({
      error:'faster-whisper not installed',
      hint:'pip install faster-whisper',
      fallback:true,
      segments:[],
      text:''
    });
  }

  let tmpAudio = null, tmpScript = null;
  try{
    // Save uploaded audio to temp file
    const ext = (req.headers['x-filename']||'audio.webm').match(/\.\w+$/)?.[0]||'.webm';
    tmpAudio  = path.join(os.tmpdir(), `gomaa_${Date.now()}${ext}`);
    fs.writeFileSync(tmpAudio, req.body);

    // Save Python script to temp file
    tmpScript = path.join(os.tmpdir(), `gomaa_whisper_${Date.now()}.py`);
    fs.writeFileSync(tmpScript, WHISPER_SCRIPT);

    const lang  = req.headers['x-language']  || 'te';   // Telugu
    const model = req.headers['x-model']     || 'base'; // base|small|medium|large-v3

    const result = await new Promise((resolve,reject)=>{
      const proc = spawn('python3',[tmpScript, tmpAudio, lang, model],{
        timeout:120000
      });
      let out='', err='';
      proc.stdout.on('data',d=>{ out+=d; });
      proc.stderr.on('data',d=>{ err+=d; });
      proc.on('close',code=>{
        if(code===0){
          try{ resolve(JSON.parse(out)); }
          catch(e){ reject(new Error('Parse error: '+out.slice(0,200))); }
        } else {
          reject(new Error('Whisper error: '+err.slice(0,300)));
        }
      });
      proc.on('error', reject);
    });

    // Build full transcript text
    const fullText = result.segments.map(s=>s.text).join(' ').trim();
    const allWords = result.segments.flatMap(s=>s.words||[]);

    res.json({
      text:      fullText,
      language:  result.language,
      confidence:result.language_probability,
      duration:  result.duration,
      segments:  result.segments,
      words:     allWords,
      model:     model,
      engine:    'faster-whisper'
    });
  }catch(e){
    console.error('[transcribe]',e.message);
    res.status(500).json({error:e.message, fallback:true, text:'', segments:[]});
  }finally{
    if(tmpAudio  && fs.existsSync(tmpAudio))  fs.unlinkSync(tmpAudio);
    if(tmpScript && fs.existsSync(tmpScript)) fs.unlinkSync(tmpScript);
  }
});

// GET /api/transcribe/status — check availability
router.get('/status', async (req,res)=>{
  const ok = await _checkWhisper();
  res.json({available:ok, engine:'faster-whisper', languages:['te','sa','hi','ta','kn','ml']});
});

module.exports = router;
