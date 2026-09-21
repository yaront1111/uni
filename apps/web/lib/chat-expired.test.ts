import {afterEach,expect,it,vi} from 'vitest';
import {platformWrite} from '../components/controlWrite';
afterEach(()=>vi.unstubAllGlobals());
it('client answer request navigates to exactly /signin?reason=expired on 401',async()=>{
 const assign=vi.fn();vi.stubGlobal('window',{location:{assign}});vi.stubGlobal('fetch',vi.fn(async()=>({status:401})));
 expect(await platformWrite('ask','memory.read',{question:'Question'})).toBeNull();expect(assign).toHaveBeenCalledExactlyOnceWith('/signin?reason=expired');
});
