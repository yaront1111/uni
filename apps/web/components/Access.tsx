import React,{useState} from 'react';
import {signIn,signOut} from 'next-auth/react';
import type {PublicDevice} from '@unai/domain';
import {Navigation} from './Navigation';
export type AccessState='signed-out'|'signing-in'|'expired'|'refused'|'desktop'|'phone';
export function Access(props:{embedded?:boolean;state:AccessState;devices:PublicDevice[];registered:boolean;currentDeviceId?:string|null;ownerScopeId?:string|null;error?:string}){
  const Frame=props.embedded?'section':'main';
  const Heading=props.embedded?'h2':'h1';
  const [state,setState]=useState(props.state),[busy,setBusy]=useState(false),[error,setError]=useState(props.error??'');
  const signedIn=state==='desktop'||state==='phone';
  async function login(){setState('signing-in');try{await signIn('google',{callbackUrl:'/'});}catch{setState('refused');}}
  async function action(path:string,purpose:string,body:unknown){
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/platform/'+path,{method:'POST',headers:{'content-type':'application/json','x-purpose':purpose,'x-correlation-id':crypto.randomUUID(),'idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)});
      if(response.status===401){window.location.assign('/signin?reason=expired');return;}
      if(!response.ok)throw new Error('The request could not be completed. Please retry.');
      window.location.reload();
    }catch{setError('The request could not be completed. Please retry.');}finally{setBusy(false);}
  }
  return <div className={props.embedded?undefined:'shell'}>{!props.embedded&&<>
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    {signedIn&&<Navigation current="devices"/>}</>}
    <Frame id={props.embedded?'configuration-devices':'content'} tabIndex={-1}>
      <p className="eyebrow">YOUR SPACE, ACROSS DEVICES</p>
      <Heading>{signedIn?'Your devices':'Welcome to Uai'}</Heading>
      {!signedIn&&<section className="card">
        <p>Sign in to your private workspace on desktop or phone.</p>
        <div role="status" aria-live="polite">
          {state==='expired'&&<p>Your session expired. Sign in again to continue.</p>}
          {state==='refused'&&<p>Sign-in was refused or cancelled. You can try again.</p>}
          {state==='signing-in'&&<p>Signing in… Complete sign-in with Google.</p>}
        </div>
        <button disabled={state==='signing-in'} onClick={login}>Sign in with Google</button>
        <p className="muted">Sign-in requests your identity only. Connecting Gmail or Drive requires separate consent.</p>
      </section>}
      {signedIn&&<>
        <p role="status">{state==='phone'?'Signed in on phone':'Signed in on desktop'}. Your devices share the same personal workspace.</p>
        {props.ownerScopeId&&<section className="card" aria-label="Owner scope">
          <h2>Owner scope</h2>
          <label htmlFor="owner-scope">Active workspace</label>
          <select id="owner-scope" name="ownerScope" defaultValue={props.ownerScopeId}><option value={props.ownerScopeId}>Personal workspace</option></select>
          <p className="muted">You have exactly one active personal owner scope. Every device you sign in to reads and writes in it.</p>
        </section>}
        {!props.registered&&<form className="card" onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);void action('devices','device.register',{displayName:data.get('displayName'),kind:data.get('kind')});}}>
          <h2>Register this device</h2>
          <label htmlFor="device-name">Device name</label><input id="device-name" name="displayName" maxLength={120} required autoComplete="off" placeholder="For example, my laptop"/>
          <label htmlFor="device-kind">Device type</label><select id="device-kind" name="kind" defaultValue={state==='phone'?'PHONE':'DESKTOP'}><option value="DESKTOP">Desktop or laptop</option><option value="PHONE">Phone</option></select>
          <button disabled={busy} type="submit">{busy?'Registering…':'Register device'}</button>
        </form>}
        <section className="card" aria-label="Registered devices"><h2>Registered devices</h2>
          {props.devices.length===0?<p>No devices registered yet.</p>:<ul className="devices">{props.devices.map(device=><li key={device.id}><div><strong>{device.displayName}</strong><p>{device.kind==='PHONE'?'Phone':'Desktop'}{device.id===props.currentDeviceId?' · This device':''}</p><small>Last active: {new Date(device.lastSeenAt).toISOString().slice(0,16).replace('T',' ')} UTC</small></div><button disabled={busy} onClick={()=>{if(window.confirm('Remove this device and sign out its sessions?'))void action('devices/'+device.id+'/revoke','device.remove',{});}}>Remove<span className="sr-only"> {device.displayName}</span></button></li>)}</ul>}
        </section>
        <div className="actions"><button disabled={busy} onClick={()=>void signOut({callbackUrl:'/signin'})}>Sign out</button><button disabled={busy} onClick={()=>{if(window.confirm('Sign out on every device?'))void action('sessions/revoke-all','auth.sign_out_all',{});}}>Sign out all devices</button></div>
      </>}
      {error&&<p role="alert">{error}</p>}
    </Frame>{!props.embedded&&<footer>Your session lasts up to seven days. Removing a device signs out its sessions.</footer>}
  </div>;
}
