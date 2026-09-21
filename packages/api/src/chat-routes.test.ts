import {expect,it} from 'vitest';
import {PLATFORM_PURPOSES,routePurpose} from './platform.js';
it('admits owner conversation lifecycle routes with their fixed purpose',()=>{
 expect(PLATFORM_PURPOSES.has('conversation.read')).toBe(true);
 expect(PLATFORM_PURPOSES.has('conversation.write')).toBe(true);
 expect(routePurpose('GET','/v1/conversations')).toBe('conversation.read');
 expect(routePurpose('GET','/v1/conversations/:id')).toBe('conversation.read');
 expect(routePurpose('POST','/v1/conversations')).toBe('conversation.write');
 expect(routePurpose('PATCH','/v1/conversations/:id')).toBe('conversation.write');
});
