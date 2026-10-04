import {randomUUID} from 'node:crypto';
import {requireThat,fail} from './errors.mjs';
import {knowledgeInput,LIMITS,copy} from './schema.mjs';
const boundary=/[。！？.!?\n]/u;
export function createProposals(state,input) {
  const source=state.sources[input.sourceId];
  requireThat(source&&source.revision===input.sourceRevision&&state.dataEpoch===input.dataEpoch&&state.policyEpoch===input.policyEpoch,'stale_generation',409);
  requireThat(source.speaker==='self','speaker_unconfirmed');
  requireThat(Array.isArray(input.proposals)&&input.proposals.length<=20,'invalid_proposal');
  requireThat(Object.keys(state.assertions).length+input.proposals.length<=LIMITS.assertions,'assertion_limit',413);
  const created=[];
  for(const p of input.proposals){
    requireThat(p&&Object.keys(p).every(k=>['text','kind','scope','validTime','sensitivity','hardConstraint','evidence','explanation'].includes(k)),'invalid_proposal');
    let value;try{value=knowledgeInput(p)}catch{fail('invalid_proposal')}
    requireThat(Array.isArray(p.evidence)&&p.evidence.length>0&&p.evidence.length<=10,'invalid_proposal');
    const evidence=p.evidence.map(e=>{
      requireThat(e&&e.sourceId===source.id&&e.revision===source.revision&&typeof e.quote==='string'&&e.quote.trim().length,'invalid_evidence');
      const start=e.start,end=e.end;
      requireThat(Number.isInteger(start)&&Number.isInteger(end)&&start>=0&&end>start&&end<=source.text.length&&source.text.slice(start,end)===e.quote,'invalid_evidence');
      // Complete sentence/line context prevents clipped literal spans hiding a trailing negation.
      requireThat((start===0||boundary.test(source.text[start-1]))&&(end===source.text.length||boundary.test(source.text[end-1])),'incomplete_evidence');
      return {sourceId:e.sourceId,revision:e.revision,start,end,quote:e.quote};
    });
    const at=new Date().toISOString();
    const assertion={...value,id:randomUUID(),revision:1,status:'proposed',evidence,policy:{model:source.policy.model,disclosure:false},createdAt:at,updatedAt:at,history:[],explanation:typeof p.explanation==='string'?p.explanation.slice(0,500):''};
    created.push(assertion);
  }
  for(const a of created)state.assertions[a.id]=a;
  return copy(created);
}
