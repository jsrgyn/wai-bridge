export interface AIRetryPolicy { baseDelayMs:number; maxDelayMs:number; maxAttempts:number }
export class RetryService {
  constructor(private readonly policy:AIRetryPolicy={baseDelayMs:1000,maxDelayMs:300000,maxAttempts:5},private readonly random= Math.random){if(policy.baseDelayMs<1||policy.maxDelayMs<policy.baseDelayMs||policy.maxAttempts<1)throw new Error('Invalid AI retry policy');}
  nextDelayMs(attempt:number):number{if(!Number.isInteger(attempt)||attempt<1)throw new Error('Invalid retry attempt');const raw=Math.min(this.policy.maxDelayMs,this.policy.baseDelayMs*2**Math.min(30,attempt-1));return Math.round(raw*(0.8+this.random()*0.4));}
  shouldRetry(attempt:number):boolean{return attempt<this.policy.maxAttempts;}
}
