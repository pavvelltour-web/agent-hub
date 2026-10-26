import { getUsr } from './users.js';
export const greet = (id) => `hi ${getUsr(id) ?? 'stranger'}`;
