import React,{useState} from 'react';
import type {RecognitionDraft} from '../lib/speech';
export function RecognitionReview({draft,onConfirm,onCancel}:{draft:RecognitionDraft;onConfirm:(text:string)=>void;onCancel:()=>void}){
 const [text,setText]=useState(draft.text);
 return <section className="card" aria-labelledby="review-title"><h2 id="review-title">Review recognised text</h2>
  <p>Recognition confidence is low or unknown. Nothing is sent or stored until you confirm.</p>
  <form onSubmit={event=>{event.preventDefault();if(text.trim())onConfirm(text.trim());}}>
   <label htmlFor="recognition-review">Your question</label><textarea id="recognition-review" autoFocus value={text} onChange={event=>setText(event.target.value)} maxLength={8000}/>
   <button type="submit" disabled={!text.trim()}>Confirm and send</button><button type="button" onClick={onCancel}>Cancel</button>
  </form>
 </section>;
}
