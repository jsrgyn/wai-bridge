import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AIResultSchema, type AIProviderAdapter, type AIResult, type MediaInput } from './contracts.js';
import { validateMedia } from './provider-adapter.js';
const execFileAsync=promisify(execFile);

export class AudioTranscriptionService {
  constructor(private readonly provider:AIProviderAdapter){}
  transcribe(input:MediaInput,signal?:AbortSignal):Promise<AIResult>{return this.provider.analyze('AUDIO_TRANSCRIPTION',validateMedia('AUDIO_TRANSCRIPTION',input),signal);}
  analyze(input:MediaInput,signal?:AbortSignal):Promise<AIResult>{return this.provider.analyze('AUDIO_ANALYSIS',validateMedia('AUDIO_ANALYSIS',input),signal);}
}
export class ImageAnalysisService {
  constructor(private readonly provider:AIProviderAdapter){}
  analyze(input:MediaInput,signal?:AbortSignal):Promise<AIResult>{return this.provider.analyze('IMAGE_ANALYSIS',validateMedia('IMAGE_ANALYSIS',input),signal);}
}
export class DocumentAnalysisService {
  constructor(private readonly provider:AIProviderAdapter,private readonly maxExtractedChars=100000){}
  async analyze(input:MediaInput,signal?:AbortSignal):Promise<AIResult>{
    const valid=validateMedia('DOCUMENT_EXTRACTION',input);
    if(valid.mimeType==='text/plain'){
      const text=new TextDecoder('utf-8',{fatal:true}).decode(valid.bytes); if(text.length>this.maxExtractedChars)throw new Error('DOCUMENT_TEXT_LIMIT');
      const result=await this.provider.analyze('DOCUMENT_EXTRACTION',{...valid,bytes:new TextEncoder().encode(text)},signal); return AIResultSchema.parse({...result,sourceRef:valid.originalContentRef});
    }
    if(!this.provider.acceptsExternalMedia)throw new Error('DOCUMENT_EXTRACTOR_UNAVAILABLE');
    return this.provider.analyze('DOCUMENT_EXTRACTION',valid,signal);
  }
}

export interface VideoArtifacts { audioBytes?:Uint8Array; frameBytes?:Uint8Array }
export interface VideoTranscoder { extract(bytes:Uint8Array,signal?:AbortSignal):Promise<VideoArtifacts> }
export class FFmpegVideoTranscoder implements VideoTranscoder {
  constructor(private readonly timeoutMs=15000){}
  async extract(bytes:Uint8Array,signal?:AbortSignal):Promise<VideoArtifacts>{
    const directory=await mkdtemp(join(tmpdir(),'wai-ai-video-'));const source=join(directory,'source.video');const audioPath=join(directory,'audio.wav');const framePath=join(directory,'frame.png');
    try{await writeFile(source,bytes,{flag:'wx',mode:0o600});const common={timeout:this.timeoutMs,maxBuffer:2*1024*1024,windowsHide:true,signal};let audioBytes:Uint8Array<ArrayBufferLike>|undefined;let frameBytes:Uint8Array<ArrayBufferLike>|undefined;
      try{await execFileAsync('ffmpeg',['-nostdin','-v','error','-i',source,'-t','30','-vn','-ac','1','-ar','16000','-f','wav',audioPath],common);audioBytes=new Uint8Array(await readFile(audioPath));}catch{audioBytes=undefined;}
      try{await execFileAsync('ffmpeg',['-nostdin','-v','error','-ss','0','-i',source,'-frames:v','1','-vf','scale=768:768:force_original_aspect_ratio=decrease','-f','image2',framePath],common);frameBytes=new Uint8Array(await readFile(framePath));}catch{frameBytes=undefined;}
      if(!audioBytes&&!frameBytes)throw new Error('VIDEO_ANALYSIS_UNAVAILABLE');return{...(audioBytes?{audioBytes}:{}),...(frameBytes?{frameBytes}:{})};
    }finally{await rm(directory,{recursive:true,force:true});}
  }
}
export class VideoAnalysisService {
  constructor(private readonly provider:AIProviderAdapter,private readonly timeoutMs=15000,private readonly maxBytes=25*1024*1024,private readonly transcoder:VideoTranscoder=new FFmpegVideoTranscoder(timeoutMs)){}
  async analyze(input:MediaInput,signal?:AbortSignal):Promise<{audio:AIResult|null;frame:AIResult|null;limitations:string[];sourceRef:string}>{
    const valid=validateMedia('VIDEO_ANALYSIS',input); if(valid.bytes.byteLength>this.maxBytes)throw new Error('MEDIA_SIZE_LIMIT');
    if(this.provider.provider==='cloud'&&!this.provider.acceptsExternalMedia)throw new Error('EXTERNAL_MEDIA_NOT_AUTHORIZED');
    const limitations:string[]=[];const artifacts=await this.transcoder.extract(valid.bytes,signal);let audio:AIResult|null=null;let frame:AIResult|null=null;
    if(artifacts.audioBytes)try{audio=await this.provider.analyze('AUDIO_TRANSCRIPTION',{mediaId:`${valid.mediaId}:audio`,mimeType:'audio/wav',bytes:new Uint8Array(artifacts.audioBytes),originalContentRef:valid.originalContentRef},signal);}catch{limitations.push('VIDEO_AUDIO_ANALYSIS_FAILED');}
    else limitations.push('VIDEO_AUDIO_UNAVAILABLE');
    if(artifacts.frameBytes)try{frame=await this.provider.analyze('IMAGE_ANALYSIS',{mediaId:`${valid.mediaId}:frame0`,mimeType:'image/png',bytes:new Uint8Array(artifacts.frameBytes),originalContentRef:valid.originalContentRef},signal);}catch{limitations.push('VIDEO_FRAME_ANALYSIS_FAILED');}
    else limitations.push('VIDEO_FRAME_UNAVAILABLE');
    if(!audio&&!frame)throw new Error('VIDEO_ANALYSIS_UNAVAILABLE');return{audio,frame,limitations,sourceRef:valid.originalContentRef};
  }
}
