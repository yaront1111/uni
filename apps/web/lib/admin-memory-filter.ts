import type {RelatedFrame} from '@unai/domain';

export interface MemoryFilters {q?:string;person?:string;topic?:string;from?:string;to?:string;kind?:string}
/** Filter the existing readable projection; never infer a belief or its certainty. */
export function filterMemoryFrames(frames:RelatedFrame[],filters:MemoryFilters):RelatedFrame[]{
  const q=filters.q?.trim().toLocaleLowerCase();
  return frames.filter(frame=>{
    if(filters.person&&!frame.people.some(person=>person.entityId===filters.person))return false;
    if(filters.topic&&!frame.threads.some(thread=>thread.memoryThreadId===filters.topic))return false;
    if(filters.kind&&frame.frameTypeId!==filters.kind)return false;
    if((filters.from||filters.to)&&!frame.sources.some(source=>{
      const day=(source.occurredAt??source.observedAt).slice(0,10);
      return (!filters.from||day>=filters.from)&&(!filters.to||day<=filters.to);
    }))return false;
    return !q||[frame.frameTypeId,...frame.people.map(person=>person.canonicalLabel??''),
      ...frame.threads.map(thread=>thread.displayTitle??''),...frame.beliefs.map(belief=>belief.predicateId),
      ...frame.sources.flatMap(source=>source.anchors.map(anchor=>anchor.text??''))].join(' ').toLocaleLowerCase().includes(q);
  });
}
