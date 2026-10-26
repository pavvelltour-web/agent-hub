const users = new Map([[1, 'ann'], [2, 'bob']]);
export function getUsr(id) {
  return users.get(id) ?? null;
}
