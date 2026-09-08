/** Desktop policy only; native injects its local feature policy. */
export function lightStudyEnabled(){return process.env.LIGHT_STUDY_ENABLED!=="0";}
