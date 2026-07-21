import { redactSecrets } from '@crontrol/shared';

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/iu;

export function childProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => {
    if (SECRET_NAME.test(name)) return false;
    return value === undefined || redactSecrets(value) === value;
  }));
}
