import { randomBytes, randomUUID } from "node:crypto";
import { seedTeam, type Seed } from "./helpers";
import {
  bindExecutorSubject,
  createGatewayConnection,
  registerGatewayServiceIdentity,
} from "@/lib/gateway/persistence";

export type GatewaySeed = Seed & {
  serviceIdentityId: string;
  subjectBindingId: string;
  connectionId: string;
  connectionRef: string;
  executorTenantId: string;
  executorSubjectId: string;
  credentialId: string;
  credentialSecret: string;
};

export async function seedGateway(): Promise<GatewaySeed> {
  const team = await seedTeam();
  const executorTenantId = `tenant-${randomUUID()}`;
  const executorSubjectId = `subject-${randomUUID()}`;
  const credentialId = randomBytes(16).toString("base64url");
  const credentialSecret = randomBytes(32).toString("base64url");
  const service = await registerGatewayServiceIdentity({
    teamId: team.teamId,
    environment: "test",
    credentialId,
    credential: credentialSecret,
  });
  const binding = await bindExecutorSubject({
    ...team,
    serviceIdentityId: service.id,
    executorTenantId,
    executorSubjectId,
  });
  const connection = await createGatewayConnection({
    teamId: team.teamId,
    memberId: team.memberId,
    subjectBindingId: binding.id,
    credentialCiphertext: `synthetic-ciphertext-${randomUUID()}`,
  });
  return {
    ...team,
    serviceIdentityId: service.id,
    subjectBindingId: binding.id,
    connectionId: connection.id,
    connectionRef: connection.connectionRef,
    executorTenantId,
    executorSubjectId,
    credentialId,
    credentialSecret,
  };
}

export function gatewayScope(seed: GatewaySeed) {
  return {
    teamId: seed.teamId,
    memberId: seed.memberId,
    serviceIdentityId: seed.serviceIdentityId,
    executorTenantId: seed.executorTenantId,
    executorSubjectId: seed.executorSubjectId,
  };
}
