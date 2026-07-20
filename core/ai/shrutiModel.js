
'use strict';
/**
 * CARNATIC 22-SHRUTI FREQUENCY MODEL
 * Ref [1]: Subramanya et al., "Representation Framework for Carnatic Music Melodies Using 22 Shruthis"
 *          Vidyabharati IIRJ 14(1) March 2022, ISSN 2319-4979
 *          https://www.viirj.org/vol14issue1/5.pdf
 * Ref [2]: https://22shruti.com/research_topic_1.asp
 *          Letter alone (S,G,N) = Swara; Letter+number (R1,M2,D1) = Shruti of that Swara
 * 
 * 22 Shruti intervals = 7 Poorna(256/243) + 10 Pramana(81/80) + 5 Nyuna(25/24)
 * Sa reference = C4 = 261.626 Hz
 * Semitone index for ragas_db.json: 0=S,1=R1,2=R2/G1,3=R3/G2,4=G3,5=M1,6=M2,7=P,8=D1,9=D2/N1,10=D3/N2,11=N3
 */
const SA_HZ = 261.626; // C4, concert pitch

// Full 22-shruti model: all swarasthana positions with ratios, frequencies, Western equivalents
const SHRUTI_MODEL = [
  // S – Shadja (Prakruti, unalterable)
  {id:'S',   swara:'S',  shruti:1,  semi:0,  ratio:1.0,       ratioStr:'1/1',     freq:261.626, western:'C4',  westernHz:261.63, shrutiType:null,               swaraType:'Prakruti', aliases:['S'],       fullName:'Shadja'},
  // R – Rishabha variants
  {id:'1R1', swara:'R1', shruti:2,  semi:1,  ratio:256/243,   ratioStr:'256/243', freq:275.622, western:'Db4', westernHz:277.18, shrutiType:'Poorna(256/243)',   swaraType:'Vikruti',  aliases:['R1'],      fullName:'Shuddha Rishabha-1'},
  {id:'2R1', swara:'R1', shruti:3,  semi:1,  ratio:16/15,     ratioStr:'16/15',   freq:279.068, western:'C#4', westernHz:277.18, shrutiType:'Nyuna(25/24)',      swaraType:'Vikruti',  aliases:['R1'],      fullName:'Shuddha Rishabha-2'},
  {id:'1R2', swara:'R2', shruti:4,  semi:2,  ratio:10/9,      ratioStr:'10/9',    freq:290.695, western:'D4',  westernHz:293.67, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['R2','G1'], fullName:'Chatushruti Rishabha-1 / Shuddha Gandhara-1'},
  {id:'2R2', swara:'R2', shruti:5,  semi:2,  ratio:9/8,       ratioStr:'9/8',     freq:294.329, western:'D4',  westernHz:293.67, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['R2','G1'], fullName:'Chatushruti Rishabha-2 / Shuddha Gandhara-2'},
  // G – Gandhara variants
  {id:'1G2', swara:'G2', shruti:6,  semi:3,  ratio:32/27,     ratioStr:'32/27',   freq:310.074, western:'Eb4', westernHz:311.13, shrutiType:'Poorna(256/243)',   swaraType:'Vikruti',  aliases:['G2','R3'], fullName:'Sadharana Gandhara-1 / Shatshruti Rishabha-1'},
  {id:'2G2', swara:'G2', shruti:7,  semi:3,  ratio:6/5,       ratioStr:'6/5',     freq:313.951, western:'Eb4', westernHz:311.13, shrutiType:'Nyuna(25/24)',      swaraType:'Vikruti',  aliases:['G2','R3'], fullName:'Sadharana Gandhara-2 / Shatshruti Rishabha-2'},
  {id:'1G3', swara:'G3', shruti:8,  semi:4,  ratio:5/4,       ratioStr:'5/4',     freq:327.033, western:'E4',  westernHz:329.63, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['G3'],      fullName:'Antara Gandhara-1'},
  {id:'2G3', swara:'G3', shruti:9,  semi:4,  ratio:81/64,     ratioStr:'81/64',   freq:330.898, western:'E4',  westernHz:329.63, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['G3'],      fullName:'Antara Gandhara-2 (Pythagorean)'},
  // M – Madhyama variants
  {id:'1M1', swara:'M1', shruti:10, semi:5,  ratio:4/3,       ratioStr:'4/3',     freq:348.834, western:'F4',  westernHz:349.23, shrutiType:'Poorna(256/243)',   swaraType:'Vikruti',  aliases:['M1'],      fullName:'Shuddha Madhyama-1'},
  {id:'2M1', swara:'M1', shruti:11, semi:5,  ratio:27/20,     ratioStr:'27/20',   freq:353.195, western:'F4',  westernHz:349.23, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['M1'],      fullName:'Shuddha Madhyama-2'},
  {id:'1M2', swara:'M2', shruti:12, semi:6,  ratio:45/32,     ratioStr:'45/32',   freq:368.288, western:'F#4', westernHz:369.99, shrutiType:'Nyuna(25/24)',      swaraType:'Vikruti',  aliases:['M2'],      fullName:'Prati Madhyama-1 (Kalyani)'},
  {id:'2M2', swara:'M2', shruti:13, semi:6,  ratio:64/45,     ratioStr:'64/45',   freq:372.510, western:'F#4', westernHz:369.99, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['M2'],      fullName:'Prati Madhyama-2'},
  {id:'3M2', swara:'M2', shruti:14, semi:6,  ratio:729/512,   ratioStr:'729/512', freq:373.073, western:'F#4', westernHz:369.99, shrutiType:'Pramana',           swaraType:'Vikruti',  aliases:['M2'],      fullName:'Prati Madhyama-3 (Vadi-Samvadi)'},
  // P – Panchama (Prakruti, unalterable)
  {id:'P',   swara:'P',  shruti:16, semi:7,  ratio:3/2,       ratioStr:'3/2',     freq:392.439, western:'G4',  westernHz:392.00, shrutiType:'Poorna(256/243)',   swaraType:'Prakruti', aliases:['P','P2'],  fullName:'Panchama'},
  // D – Dhaivata variants
  {id:'1D1', swara:'D1', shruti:17, semi:8,  ratio:128/81,    ratioStr:'128/81',  freq:413.434, western:'Ab4', westernHz:415.31, shrutiType:'Poorna(256/243)',   swaraType:'Vikruti',  aliases:['D1'],      fullName:'Shuddha Dhaivata-1'},
  {id:'2D1', swara:'D1', shruti:18, semi:8,  ratio:8/5,       ratioStr:'8/5',     freq:418.602, western:'Ab4', westernHz:415.31, shrutiType:'Nyuna(25/24)',      swaraType:'Vikruti',  aliases:['D1'],      fullName:'Shuddha Dhaivata-2'},
  {id:'1D2', swara:'D2', shruti:19, semi:9,  ratio:5/3,       ratioStr:'5/3',     freq:436.044, western:'A4',  westernHz:440.00, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['D2','N1'], fullName:'Chatushruti Dhaivata-1 / Shuddha Nishada-1'},
  {id:'2D2', swara:'D2', shruti:20, semi:9,  ratio:27/16,     ratioStr:'27/16',   freq:441.181, western:'A4',  westernHz:440.00, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['D2','N1'], fullName:'Chatushruti Dhaivata-2 / Shuddha Nishada-2'},
  // N – Nishada variants
  {id:'1N2', swara:'N2', shruti:21, semi:10, ratio:16/9,      ratioStr:'16/9',    freq:465.113, western:'Bb4', westernHz:466.16, shrutiType:'Poorna(256/243)',   swaraType:'Vikruti',  aliases:['N2','D3'], fullName:'Kaisika Nishada-1 / Shatshruti Dhaivata-1'},
  {id:'2N2', swara:'N2', shruti:22, semi:10, ratio:9/5,       ratioStr:'9/5',     freq:470.927, western:'Bb4', westernHz:466.16, shrutiType:'Nyuna(25/24)',      swaraType:'Vikruti',  aliases:['N2','D3'], fullName:'Kaisika Nishada-2 / Shatshruti Dhaivata-2'},
  {id:'1N3', swara:'N3', shruti:23, semi:11, ratio:15/8,      ratioStr:'15/8',    freq:490.549, western:'B4',  westernHz:493.88, shrutiType:'Nyuna',             swaraType:'Vikruti',  aliases:['N3'],      fullName:'Kakali Nishada-1'},
  {id:'2N3', swara:'N3', shruti:24, semi:11, ratio:243/128,   ratioStr:'243/128', freq:496.680, western:'B4',  westernHz:493.88, shrutiType:'Pramana(81/80)',    swaraType:'Vikruti',  aliases:['N3'],      fullName:'Kakali Nishada-2 (Vadi-Samvadi)'},
  // S' – Tara Shadja (upper octave)
  {id:"S'",  swara:"S'", shruti:1,  semi:0,  ratio:2.0,       ratioStr:'2/1',     freq:523.252, western:'C5',  westernHz:523.25, shrutiType:null,               swaraType:'Prakruti', aliases:["S'","S-"], fullName:'Tara Shadja (upper octave)'},
];

const _SORTED = SHRUTI_MODEL.filter(s=>s.id!=="S'").sort((a,b)=>a.ratio-b.ratio);

function hzToShrutiEntry(freq, sa_hz){
  if(!freq||!sa_hz||freq<=0||sa_hz<=0) return SHRUTI_MODEL[0];
  let r=freq/sa_hz;
  while(r>=2.0)r/=2; while(r<1.0)r*=2;
  let best=_SORTED[0],bd=Infinity;
  for(const s of _SORTED){const d=Math.abs(r-s.ratio);if(d<bd){bd=d;best=s;}}
  return best;
}
function hzToSemitone(freq,sa_hz){ return hzToShrutiEntry(freq,sa_hz).semi; }
function detectSaHz(frames){
  const CENT=50;
  const voiced=frames.filter(f=>f&&f.freq>60&&f.freq<1500);
  if(!voiced.length) return SA_HZ;
  const clusters=[];
  for(const {freq} of voiced){
    let f=freq; while(f>600)f/=2; while(f<150)f*=2;
    const cl=clusters.find(c=>Math.abs(1200*Math.log2(f/c.freq))<CENT);
    if(cl){cl.count++;cl.freqSum+=f;cl.freq=cl.freqSum/cl.count;}
    else clusters.push({freq:f,freqSum:f,count:1});
  }
  clusters.sort((a,b)=>b.count-a.count);
  return clusters[0].freq;
}

// Map semitone 0-11 → primary swara name (matches ragas_db.json)
const SEMI_TO_SWARA_PRIMARY={0:'S',1:'R1',2:'R2',3:'R3',4:'G3',5:'M1',6:'M2',7:'P',8:'D1',9:'D2',10:'D3',11:'N3'};
// Map semitone 0-11 → Western note (Sa=C4)
const SEMI_TO_WESTERN={0:'C',1:'C#/Db',2:'D',3:'Eb/D#',4:'E',5:'F',6:'F#/Gb',7:'G',8:'Ab/G#',9:'A',10:'Bb/A#',11:'B'};
// Ratio lookup table (from paper Table 4)
const RATIO_TABLE=SHRUTI_MODEL.reduce((acc,s)=>{if(s.id!=="S'")acc[s.id]={ratio:s.ratio,ratioStr:s.ratioStr,freq_c4:+(SA_HZ*s.ratio).toFixed(3),semi:s.semi,western:s.western,shrutiType:s.shrutiType};return acc;},{});

module.exports={SHRUTI_MODEL,RATIO_TABLE,SEMI_TO_SWARA_PRIMARY,SEMI_TO_WESTERN,SA_HZ,hzToShrutiEntry,hzToSemitone,detectSaHz};
