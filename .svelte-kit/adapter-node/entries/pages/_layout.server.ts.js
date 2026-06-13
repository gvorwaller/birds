const load = ({ locals }) => {
  return {
    user: locals.user ?? null
  };
};
export {
  load
};
