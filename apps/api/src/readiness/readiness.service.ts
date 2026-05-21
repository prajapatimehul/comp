import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  db,
  Departments,
  PolicyStatus,
  RiskCategory,
  RiskStatus,
  TaskStatus,
  VendorCategory,
  VendorStatus,
} from '@db';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiKeyService } from '../auth/api-key.service';
import { FrameworksService } from '../frameworks/frameworks.service';

const registerSchema = z.object({
  companyName: z.string().trim().min(2),
  ownerEmail: z.string().trim().email(),
  ownerName: z.string().trim().min(1).default('Comp AI Agent'),
  website: z.string().trim().url().optional(),
  framework: z.string().trim().min(1).default('SOC 2 Type 1'),
});

const vendorSchema = z.object({
  name: z.string().trim().min(1),
  website: z.string().trim().url().optional(),
  description: z.string().trim().optional(),
  category: z.string().trim().optional(),
  isSubProcessor: z.boolean().optional(),
});

const riskSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().optional(),
  category: z.string().trim().optional(),
});

const applySchema = z.object({
  repoContext: z.record(z.string(), z.unknown()).optional(),
  vendors: z.array(vendorSchema).default([]),
  risks: z.array(riskSchema).default([]),
  framework: z.string().trim().min(1).default('SOC 2 Type 1'),
  markOnboardingComplete: z.boolean().default(true),
});

const quarantineSchema = z.object({
  dryRun: z.boolean().default(false),
});

type RegisterInput = z.infer<typeof registerSchema>;
type ApplyInput = z.infer<typeof applySchema>;
type VendorInput = z.infer<typeof vendorSchema>;
type RiskInput = z.infer<typeof riskSchema>;

type SelectedFramework = {
  id: string;
  name: string;
  description: string | null;
};

const LEGACY_FAKE_FRAMEWORK_NAME = 'SOC 2 Type 1 Readiness';

const LEGACY_FAKE_CONTROL_NAMES = [
  'Governance and accountability controls',
  'Security communication controls',
  'Risk assessment controls',
  'Monitoring and review controls',
  'Operational control activities',
  'Access control safeguards',
  'System operations controls',
  'Secure SDLC controls',
  'Vendor and risk mitigation controls',
  'Availability and continuity controls',
];

const LEGACY_FAKE_TASK_TITLES = [
  'Approve information security policy',
  'Assign security ownership and reporting lines',
  'Publish acceptable use requirements',
  'Record security leadership meeting minutes',
  'Maintain risk register',
  'Review risk treatment decisions',
  'Review control monitoring results',
  'Document follow-up actions',
  'Document change approval workflow',
  'Review production access',
  'Complete RBAC matrix review',
  'Review privileged access',
  'Run incident response tabletop exercise',
  'Review security monitoring alerts',
  'Review GitHub branch protection',
  'Document release approvals',
  'Assess critical vendors',
  'Review vendor risk mitigations',
  'Document backup and recovery inventory',
  'Review cloud availability posture',
];

const LEGACY_FAKE_RISK_TREATMENT =
  'Track owner, evidence, monitoring, and quarterly review cadence before Type 1 audit.';

@Injectable()
export class ReadinessService {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly frameworksService: FrameworksService,
  ) {}

  async register(bootstrapToken: string | undefined, rawBody: unknown) {
    this.assertBootstrapToken(bootstrapToken);
    const input = registerSchema.parse(rawBody);
    const frameworks = await this.resolveFrameworks(input.framework);

    const { user, organization, member, created } =
      await this.upsertOrganization(input, frameworks);
    const frameworkImport = await this.ensureBuiltInFrameworks(
      organization.id,
      frameworks,
    );

    const apiKey = await this.apiKeyService.create(
      organization.id,
      `compctl-${new Date().toISOString()}`,
      'never',
      this.apiKeyService.getAvailableScopes(),
    );

    return {
      success: true,
      data: {
        organizationId: organization.id,
        organizationName: organization.name,
        ownerUserId: user.id,
        ownerMemberId: member.id,
        created,
        apiKey: apiKey.key,
        apiUrl: this.getApiUrl(),
        appUrl: this.getAppUrl(organization.id),
        frameworkImport,
        aws: {
          externalId: organization.id,
          roleAssumerArn: this.getRoleAssumerArn(),
        },
        nextCommands: [
          'compctl aws setup-role --profile crypto --external-id <organizationId> --principal-arn <roleAssumerArn>',
          'compctl aws connect --role-arn <roleArn> --regions eu-central-1',
          'compctl aws scan',
          'compctl readiness quarantine-generated',
          'compctl readiness apply --repo /path/to/customer/repo',
          'compctl readiness status',
        ],
      },
    };
  }

  async applyReadiness(organizationId: string, rawBody: unknown) {
    const input = applySchema.parse(rawBody);
    const frameworks = await this.resolveFrameworks(input.framework);
    const frameworkImport = await this.ensureBuiltInFrameworks(
      organizationId,
      frameworks,
    );
    const context = await this.upsertContext(organizationId, input);
    const vendors = await this.upsertCandidateVendors(
      organizationId,
      input.vendors,
    );
    const risks = await this.upsertCandidateRisks(organizationId, input.risks);

    if (input.markOnboardingComplete) {
      await this.completeCliOnboarding(organizationId);
    }

    const status = await this.getStatus(organizationId);
    return {
      success: true,
      data: {
        mode: 'api-flow-no-fake-completion',
        frameworkImport,
        context,
        vendors: {
          upserted: vendors.length,
          names: vendors.map((v) => v.name),
          status: 'not_assessed_or_existing',
        },
        risks: {
          upserted: risks.length,
          titles: risks.map((r) => r.title),
          status: 'pending_or_existing',
        },
        evidence: {
          created: 0,
          approved: 0,
          note: 'compctl does not create or approve evidence. Evidence remains pending until a user uploads and reviews it.',
        },
        tasks: {
          completedByCompctl: 0,
          note: 'Tasks imported from built-in templates remain todo until completed through the normal task workflow.',
        },
        policies: {
          publishedByCompctl: 0,
          note: 'Policies imported from built-in templates remain draft until a user publishes them.',
        },
        status: status.data,
      },
    };
  }

  async quarantineGenerated(organizationId: string, rawBody: unknown) {
    const input = quarantineSchema.parse(rawBody ?? {});
    const now = new Date();

    const [
      legacyFrameworks,
      legacyTasks,
      legacyControls,
      evidenceSubmissions,
      policies,
      vendors,
      risks,
    ] = await Promise.all([
      db.customFramework.findMany({
        where: { organizationId, name: LEGACY_FAKE_FRAMEWORK_NAME },
        select: { id: true },
      }),
      db.task.findMany({
        where: {
          organizationId,
          archivedAt: null,
          taskTemplateId: null,
          title: { in: LEGACY_FAKE_TASK_TITLES },
        },
        select: { id: true },
      }),
      db.control.findMany({
        where: {
          organizationId,
          archivedAt: null,
          controlTemplateId: null,
          name: { in: LEGACY_FAKE_CONTROL_NAMES },
        },
        select: { id: true },
      }),
      db.evidenceSubmission.findMany({
        where: { organizationId },
        select: { id: true, data: true },
      }),
      db.policy.findMany({
        where: {
          organizationId,
          archivedAt: null,
          isArchived: false,
          policyTemplateId: null,
        },
        select: { id: true, content: true },
      }),
      db.vendor.findMany({
        where: { organizationId },
        select: { id: true, name: true, description: true, status: true },
      }),
      db.risk.findMany({
        where: { organizationId },
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          treatmentStrategyDescription: true,
        },
      }),
    ]);

    const fakeEvidenceIds = evidenceSubmissions
      .filter((submission) =>
        this.jsonIncludes(submission.data, 'compctlGenerated'),
      )
      .map((submission) => submission.id);
    const fakePolicyIds = policies
      .filter((policy) =>
        this.jsonIncludes(policy.content, 'This fake Type 1 readiness policy'),
      )
      .map((policy) => policy.id);
    const fakeVendorIds = vendors
      .filter(
        (vendor) =>
          vendor.status === VendorStatus.assessed &&
          (vendor.description.toLowerCase().includes('compctl') ||
            vendor.description
              .toLowerCase()
              .includes('detected during repository inspection') ||
            vendor.description.includes(
              'Cloud infrastructure hosting, networking, monitoring, and storage.',
            ) ||
            vendor.description.includes(
              'Source control, code review, and CI/CD workflow provider.',
            )),
      )
      .map((vendor) => vendor.id);
    const fakeRiskIds = risks
      .filter((risk) => {
        const isLegacyGeneratedRisk =
          risk.description.toLowerCase().includes('compctl') ||
          risk.treatmentStrategyDescription === LEGACY_FAKE_RISK_TREATMENT ||
          [
            'Unauthorized cloud access',
            'Vendor concentration and third-party dependency',
            'Incomplete security evidence before Type 1 audit',
          ].includes(risk.title);

        return (
          isLegacyGeneratedRisk &&
          (risk.status !== RiskStatus.pending ||
            risk.treatmentStrategyDescription === LEGACY_FAKE_RISK_TREATMENT ||
            risk.description.toLowerCase().includes('compctl'))
        );
      })
      .map((risk) => risk.id);

    const summary = {
      dryRun: input.dryRun,
      customFrameworksToDelete: legacyFrameworks.length,
      fakeTasksToArchive: legacyTasks.length,
      fakeControlsToArchive: legacyControls.length,
      fakePoliciesToArchive: fakePolicyIds.length,
      fakeEvidenceToDelete: fakeEvidenceIds.length,
      fakeVendorsToDemote: fakeVendorIds.length,
      fakeRisksToMarkPending: fakeRiskIds.length,
    };

    if (input.dryRun) {
      return { success: true, data: summary };
    }

    await db.$transaction(async (tx) => {
      if (fakeEvidenceIds.length > 0) {
        await tx.evidenceSubmission.deleteMany({
          where: { id: { in: fakeEvidenceIds }, organizationId },
        });
      }
      if (legacyTasks.length > 0) {
        await tx.task.updateMany({
          where: {
            id: { in: legacyTasks.map((task) => task.id) },
            organizationId,
          },
          data: {
            status: TaskStatus.todo,
            lastCompletedAt: null,
            reviewDate: null,
            archivedAt: now,
          },
        });
      }
      if (legacyControls.length > 0) {
        await tx.control.updateMany({
          where: {
            id: { in: legacyControls.map((control) => control.id) },
            organizationId,
          },
          data: { archivedAt: now },
        });
      }
      if (fakePolicyIds.length > 0) {
        await tx.policy.updateMany({
          where: { id: { in: fakePolicyIds }, organizationId },
          data: {
            status: PolicyStatus.draft,
            isArchived: true,
            archivedAt: now,
            lastArchivedAt: now,
            lastPublishedAt: null,
          },
        });
      }
      if (fakeVendorIds.length > 0) {
        await tx.vendor.updateMany({
          where: { id: { in: fakeVendorIds }, organizationId },
          data: { status: VendorStatus.not_assessed },
        });
      }
      if (fakeRiskIds.length > 0) {
        await tx.risk.updateMany({
          where: { id: { in: fakeRiskIds }, organizationId },
          data: {
            status: RiskStatus.pending,
            treatmentStrategyDescription: null,
          },
        });
      }
      if (legacyFrameworks.length > 0) {
        await tx.customFramework.deleteMany({
          where: {
            id: { in: legacyFrameworks.map((framework) => framework.id) },
            organizationId,
          },
        });
      }
    });

    const status = await this.getStatus(organizationId);
    return { success: true, data: { ...summary, status: status.data } };
  }

  async getStatus(organizationId: string) {
    const [
      organization,
      onboarding,
      tasks,
      policies,
      vendors,
      risks,
      evidenceSubmissions,
      connections,
      latestCloudRun,
      frameworks,
    ] = await Promise.all([
      db.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          name: true,
          website: true,
          onboardingCompleted: true,
          hasAccess: true,
        },
      }),
      db.onboarding.findUnique({ where: { organizationId } }),
      db.task.findMany({
        where: { organizationId, archivedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          controls: { select: { id: true } },
        },
      }),
      db.policy.findMany({
        where: { organizationId, archivedAt: null, isArchived: false },
        select: { id: true, name: true, status: true },
      }),
      db.vendor.findMany({
        where: { organizationId },
        select: { id: true, name: true, status: true, website: true },
      }),
      db.risk.findMany({
        where: { organizationId },
        select: { id: true, title: true, status: true, category: true },
      }),
      db.evidenceSubmission.findMany({
        where: { organizationId },
        select: { id: true, formType: true, status: true, submittedAt: true },
      }),
      db.integrationConnection.findMany({
        where: { organizationId, status: { not: 'disconnected' } },
        include: { provider: true },
      }),
      db.integrationCheckRun.findFirst({
        where: { connection: { organizationId } },
        orderBy: { createdAt: 'desc' },
        include: { results: { select: { passed: true, severity: true } } },
      }),
      this.getFrameworkScores(organizationId),
    ]);

    if (!organization) {
      throw new BadRequestException('Organization not found');
    }

    const doneTasks = tasks.filter(
      (task) =>
        task.status === TaskStatus.done ||
        task.status === TaskStatus.not_relevant,
    ).length;
    const publishedPolicies = policies.filter(
      (policy) => policy.status === PolicyStatus.published,
    ).length;
    const approvedEvidence = evidenceSubmissions.filter(
      (submission) => submission.status === 'approved',
    ).length;
    const assessedVendors = vendors.filter(
      (vendor) => vendor.status === VendorStatus.assessed,
    ).length;
    const awsConnections = connections.filter(
      (connection) => connection.provider.slug === 'aws',
    );

    const scoreRows = [
      { done: doneTasks, total: tasks.length },
      { done: publishedPolicies, total: policies.length },
      {
        done: approvedEvidence,
        total: Math.max(5, evidenceSubmissions.length),
      },
      { done: assessedVendors, total: Math.max(1, vendors.length) },
      { done: awsConnections.length > 0 ? 1 : 0, total: 1 },
    ];
    const readinessScore = Math.round(
      scoreRows.reduce((sum, row) => {
        if (row.total === 0) return sum + 100;
        return sum + Math.round((row.done / row.total) * 100);
      }, 0) / scoreRows.length,
    );

    return {
      success: true,
      data: {
        organization,
        onboarding,
        readinessScore,
        counts: {
          tasks: {
            total: tasks.length,
            done: doneTasks,
            remaining: Math.max(0, tasks.length - doneTasks),
            byStatus: this.countBy(tasks.map((task) => task.status)),
          },
          policies: {
            total: policies.length,
            published: publishedPolicies,
            draft: policies.length - publishedPolicies,
          },
          evidence: {
            total: evidenceSubmissions.length,
            approved: approvedEvidence,
            byStatus: this.countBy(evidenceSubmissions.map((e) => e.status)),
          },
          vendors: {
            total: vendors.length,
            assessed: assessedVendors,
            byStatus: this.countBy(vendors.map((vendor) => vendor.status)),
          },
          risks: {
            total: risks.length,
            byStatus: this.countBy(risks.map((risk) => risk.status)),
          },
          integrations: {
            total: connections.length,
            aws: awsConnections.length,
          },
        },
        frameworks,
        cloud: latestCloudRun
          ? {
              latestRunId: latestCloudRun.id,
              connectionId: latestCloudRun.connectionId,
              status: latestCloudRun.status,
              totalChecked: latestCloudRun.totalChecked,
              passedCount: latestCloudRun.passedCount,
              failedCount: latestCloudRun.failedCount,
              completedAt: latestCloudRun.completedAt,
              severities: this.countBy(
                latestCloudRun.results.map((result) => result.severity),
              ),
            }
          : null,
        truthModel: {
          fakeReadinessSeederDisabled: true,
          compctlCompletedTasks: 0,
          compctlPublishedPolicies: 0,
          compctlApprovedEvidence: 0,
          humanReviewRequiredFor: [
            'policy approval and publishing',
            'task completion',
            'evidence upload and review',
            'vendor assessment',
            'risk treatment decisions',
          ],
        },
        appUrls: {
          overview: `${this.getAppUrl(organization.id)}/overview`,
          frameworks: `${this.getAppUrl(organization.id)}/frameworks`,
          tasks: `${this.getAppUrl(organization.id)}/tasks`,
          cloudTests: `${this.getAppUrl(organization.id)}/cloud-tests`,
          vendors: `${this.getAppUrl(organization.id)}/vendors`,
          risks: `${this.getAppUrl(organization.id)}/risk`,
        },
      },
    };
  }

  private assertBootstrapToken(actual: string | undefined) {
    const expected =
      process.env.COMPCTL_BOOTSTRAP_TOKEN ?? process.env.SERVICE_TOKEN_COMPCTL;
    if (!expected) {
      throw new UnauthorizedException(
        'COMPCTL_BOOTSTRAP_TOKEN is not configured',
      );
    }
    if (!actual) {
      throw new UnauthorizedException('x-compctl-token header is required');
    }

    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    const matches =
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer);
    if (!matches) {
      throw new UnauthorizedException('Invalid compctl bootstrap token');
    }
  }

  private async upsertOrganization(
    input: RegisterInput,
    frameworks: SelectedFramework[],
  ) {
    const user = await db.user.upsert({
      where: { email: input.ownerEmail },
      create: {
        email: input.ownerEmail,
        name: input.ownerName,
        emailVerified: true,
      },
      update: { name: input.ownerName },
    });

    let organization = await db.organization.findFirst({
      where: {
        name: input.companyName,
        members: { some: { userId: user.id, role: { contains: 'owner' } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    let created = false;
    if (!organization) {
      organization = await db.organization.create({
        data: {
          name: input.companyName,
          website: input.website,
          hasAccess: true,
          onboardingCompleted: false,
          members: {
            create: {
              userId: user.id,
              role: 'owner',
              department: Departments.it,
              jobTitle: 'Compliance Owner',
            },
          },
        },
      });
      created = true;
    } else if (input.website && organization.website !== input.website) {
      organization = await db.organization.update({
        where: { id: organization.id },
        data: { website: input.website },
      });
    }

    const member =
      (await db.member.findFirst({
        where: { organizationId: organization.id, userId: user.id },
      })) ??
      (await db.member.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: 'owner',
          department: Departments.it,
          jobTitle: 'Compliance Owner',
        },
      }));

    await db.onboarding.upsert({
      where: { organizationId: organization.id },
      create: { organizationId: organization.id, triggerJobCompleted: false },
      update: {},
    });
    await this.syncSetupContext(organization.id, frameworks);

    return { user, organization, member, created };
  }

  private async resolveFrameworks(
    frameworkNames: string,
  ): Promise<SelectedFramework[]> {
    const available = await db.frameworkEditorFramework.findMany({
      where: { visible: true },
      select: { id: true, name: true, description: true },
      orderBy: { name: 'asc' },
    });
    if (available.length === 0) {
      throw new BadRequestException(
        'No visible built-in frameworks are configured',
      );
    }

    const requestedNames = frameworkNames
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const selected = new Map<string, SelectedFramework>();
    for (const requestedName of requestedNames) {
      const match = this.bestFrameworkMatch(requestedName, available);
      selected.set(match.id, match);
    }

    return Array.from(selected.values());
  }

  private bestFrameworkMatch(
    requestedName: string,
    available: SelectedFramework[],
  ): SelectedFramework {
    const requested = requestedName.toLowerCase();
    const exact = available.find(
      (framework) => framework.name.toLowerCase() === requested,
    );
    if (exact) return exact;

    const soc2Requested = requested.includes('soc') && requested.includes('2');
    if (soc2Requested) {
      const soc2 = available.find((framework) => {
        const name = framework.name.toLowerCase();
        return name.includes('soc') && name.includes('2');
      });
      if (soc2) return soc2;
    }

    const contained = available.find((framework) => {
      const name = framework.name.toLowerCase();
      return name.includes(requested) || requested.includes(name);
    });
    if (contained) return contained;

    throw new BadRequestException(
      `Could not find a visible built-in framework matching "${requestedName}"`,
    );
  }

  private async ensureBuiltInFrameworks(
    organizationId: string,
    frameworks: SelectedFramework[],
  ) {
    const frameworkIds = frameworks.map((framework) => framework.id);
    const existing = await db.frameworkInstance.findMany({
      where: { organizationId, frameworkId: { in: frameworkIds } },
      select: { frameworkId: true },
    });
    const existingIds = new Set(
      existing.map((framework) => framework.frameworkId),
    );
    const missingIds = frameworkIds.filter((id) => !existingIds.has(id));

    if (missingIds.length > 0) {
      await this.frameworksService.addFrameworks(organizationId, missingIds);
    }

    const [frameworkInstances, controls, policies, tasks] = await Promise.all([
      db.frameworkInstance.findMany({
        where: { organizationId, frameworkId: { in: frameworkIds } },
        include: { framework: { select: { id: true, name: true } } },
      }),
      db.control.count({
        where: {
          organizationId,
          controlTemplateId: { not: null },
          archivedAt: null,
        },
      }),
      db.policy.count({
        where: {
          organizationId,
          policyTemplateId: { not: null },
          archivedAt: null,
          isArchived: false,
        },
      }),
      db.task.count({
        where: {
          organizationId,
          taskTemplateId: { not: null },
          archivedAt: null,
        },
      }),
    ]);

    return {
      source: 'built-in framework templates',
      requested: frameworks.map((framework) => ({
        id: framework.id,
        name: framework.name,
      })),
      added: missingIds.length,
      existing: existingIds.size,
      instances: frameworkInstances.map((instance) => ({
        id: instance.id,
        frameworkId: instance.frameworkId,
        name: instance.framework?.name,
      })),
      counts: { controls, policies, tasks },
    };
  }

  private async syncSetupContext(
    organizationId: string,
    frameworks: SelectedFramework[],
  ) {
    await this.upsertContextEntry(organizationId, {
      question: 'Which compliance frameworks do you need?',
      answer: frameworks.map((framework) => framework.name).join(', '),
      tags: ['onboarding', 'compctl'],
    });
    await this.upsertContextEntry(organizationId, {
      question: 'frameworkIds',
      answer: JSON.stringify(frameworks.map((framework) => framework.id)),
      tags: ['onboarding', 'compctl'],
    });
  }

  private async upsertContext(organizationId: string, input: ApplyInput) {
    const entries = [
      {
        question: 'Compctl repository inspection context',
        answer: JSON.stringify(
          {
            ...(input.repoContext ?? {}),
            compctlReadOnly: true,
            verificationStatus: 'unverified_human_review_required',
          },
          null,
          2,
        ),
        tags: ['compctl', 'repository', 'onboarding', 'unverified'],
      },
      {
        question: 'Compctl readiness workflow mode',
        answer:
          'CLI captured context and used built-in Comp AI framework templates. It did not complete tasks, publish policies, approve evidence, assess vendors, or close risks.',
        tags: ['compctl', 'onboarding', 'truthful-readiness'],
      },
    ];

    if (input.vendors.length > 0) {
      entries.push({
        question: 'What software do you use?',
        answer: input.vendors.map((vendor) => vendor.name).join(', '),
        tags: ['onboarding', 'compctl', 'unverified'],
      });
      entries.push({
        question: 'What are your custom vendors and their websites?',
        answer: JSON.stringify(
          input.vendors.map((vendor) => ({
            name: vendor.name,
            website: vendor.website,
          })),
        ),
        tags: ['onboarding', 'compctl', 'unverified'],
      });
    }

    let upserted = 0;
    for (const entry of entries) {
      await this.upsertContextEntry(organizationId, entry);
      upserted += 1;
    }
    return { upserted };
  }

  private async upsertContextEntry(
    organizationId: string,
    entry: { question: string; answer: string; tags: string[] },
  ) {
    const existing = await db.context.findFirst({
      where: { organizationId, question: entry.question },
    });
    if (existing) {
      return db.context.update({
        where: { id: existing.id },
        data: { answer: entry.answer, tags: entry.tags },
      });
    }
    return db.context.create({ data: { organizationId, ...entry } });
  }

  private async upsertCandidateVendors(
    organizationId: string,
    vendors: VendorInput[],
  ) {
    const deduped = new Map<string, VendorInput>();
    for (const vendor of vendors) {
      deduped.set(vendor.name.toLowerCase(), vendor);
    }

    const results: Array<{ id: string; name: string }> = [];
    for (const vendor of deduped.values()) {
      const existing = await db.vendor.findFirst({
        where: {
          organizationId,
          name: { equals: vendor.name, mode: 'insensitive' },
        },
      });
      const data = {
        name: vendor.name,
        website: vendor.website,
        description:
          vendor.description ??
          `${vendor.name} was identified from read-only compctl context and requires human vendor review.`,
        category: this.toVendorCategory(vendor.category),
        isSubProcessor: vendor.isSubProcessor ?? true,
      };
      const saved = existing
        ? await db.vendor.update({
            where: { id: existing.id },
            data: {
              ...data,
              status:
                existing.status === VendorStatus.assessed
                  ? existing.status
                  : VendorStatus.not_assessed,
            },
          })
        : await db.vendor.create({
            data: {
              ...data,
              organizationId,
              status: VendorStatus.not_assessed,
            },
          });
      results.push({ id: saved.id, name: saved.name });
    }
    return results;
  }

  private async upsertCandidateRisks(
    organizationId: string,
    risks: RiskInput[],
  ) {
    const deduped = new Map<string, RiskInput>();
    for (const risk of risks) {
      deduped.set(risk.title.toLowerCase(), risk);
    }

    const results: Array<{ id: string; title: string }> = [];
    for (const risk of deduped.values()) {
      const existing = await db.risk.findFirst({
        where: {
          organizationId,
          title: { equals: risk.title, mode: 'insensitive' },
        },
      });
      const data = {
        title: risk.title,
        description:
          risk.description ??
          `${risk.title} was identified from read-only compctl context and requires human risk review.`,
        category: this.toRiskCategory(risk.category),
        department: Departments.it,
      };
      const saved = existing
        ? await db.risk.update({
            where: { id: existing.id },
            data: {
              ...data,
              status:
                existing.status === RiskStatus.closed
                  ? existing.status
                  : RiskStatus.pending,
            },
          })
        : await db.risk.create({
            data: {
              ...data,
              organizationId,
              status: RiskStatus.pending,
            },
          });
      results.push({ id: saved.id, title: saved.title });
    }
    return results;
  }

  private async completeCliOnboarding(organizationId: string) {
    const [policies, tasks, vendors, risks, awsConnections] = await Promise.all(
      [
        db.policy.count({
          where: {
            organizationId,
            archivedAt: null,
            isArchived: false,
            policyTemplateId: { not: null },
          },
        }),
        db.task.count({
          where: {
            organizationId,
            archivedAt: null,
            taskTemplateId: { not: null },
          },
        }),
        db.vendor.count({ where: { organizationId } }),
        db.risk.count({ where: { organizationId } }),
        db.integrationConnection.count({
          where: {
            organizationId,
            status: { not: 'disconnected' },
            provider: { slug: 'aws' },
          },
        }),
      ],
    );

    await db.organization.update({
      where: { id: organizationId },
      data: { onboardingCompleted: true, hasAccess: true },
    });
    await db.onboarding.upsert({
      where: { organizationId },
      create: {
        organizationId,
        policies: policies > 0,
        employees: false,
        vendors: vendors > 0,
        integrations: awsConnections > 0,
        risk: risks > 0,
        team: true,
        tasks: tasks > 0,
        triggerJobCompleted: true,
      },
      update: {
        policies: policies > 0,
        vendors: vendors > 0,
        integrations: awsConnections > 0,
        risk: risks > 0,
        team: true,
        tasks: tasks > 0,
        triggerJobCompleted: true,
        triggerJobId: null,
      },
    });
  }

  private async getFrameworkScores(organizationId: string) {
    const frameworkInstances = await db.frameworkInstance.findMany({
      where: { organizationId },
      include: {
        framework: { select: { name: true } },
        customFramework: { select: { name: true } },
        requirementsMapped: {
          where: { archivedAt: null },
          include: {
            control: {
              include: {
                policies: { select: { id: true, status: true } },
                tasks: { select: { id: true, status: true } },
              },
            },
          },
        },
      },
    });

    return frameworkInstances.map((frameworkInstance) => {
      const controls = frameworkInstance.requirementsMapped
        .map((map) => map.control)
        .filter(
          (control, index, list) =>
            list.findIndex((c) => c.id === control.id) === index,
        );
      const policyMap = new Map<string, PolicyStatus>();
      const taskMap = new Map<string, TaskStatus>();
      for (const control of controls) {
        for (const policy of control.policies)
          policyMap.set(policy.id, policy.status);
        for (const task of control.tasks) taskMap.set(task.id, task.status);
      }
      const totalPolicies = policyMap.size;
      const publishedPolicies = [...policyMap.values()].filter(
        (status) => status === PolicyStatus.published,
      ).length;
      const totalTasks = taskMap.size;
      const doneTasks = [...taskMap.values()].filter(
        (status) =>
          status === TaskStatus.done || status === TaskStatus.not_relevant,
      ).length;
      const policyScore =
        totalPolicies > 0
          ? Math.round((publishedPolicies / totalPolicies) * 100)
          : 100;
      const taskScore =
        totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 100;
      return {
        id: frameworkInstance.id,
        name:
          frameworkInstance.framework?.name ??
          frameworkInstance.customFramework?.name ??
          'Framework',
        isCustom: frameworkInstance.customFrameworkId !== null,
        controls: controls.length,
        policies: { total: totalPolicies, published: publishedPolicies },
        tasks: { total: totalTasks, done: doneTasks },
        complianceScore: Math.round((policyScore + taskScore) / 2),
      };
    });
  }

  private toVendorCategory(category: string | undefined): VendorCategory {
    if (!category) return VendorCategory.other;
    const normalized = category.replace(
      /-/g,
      '_',
    ) as keyof typeof VendorCategory;
    return VendorCategory[normalized] ?? VendorCategory.other;
  }

  private toRiskCategory(category: string | undefined): RiskCategory {
    if (!category) return RiskCategory.technology;
    const normalized = category.replace(/-/g, '_') as keyof typeof RiskCategory;
    return RiskCategory[normalized] ?? RiskCategory.technology;
  }

  private jsonIncludes(value: unknown, needle: string) {
    return JSON.stringify(value ?? '').includes(needle);
  }

  private countBy(values: Array<string | null>): Record<string, number> {
    return values.reduce<Record<string, number>>((acc, value) => {
      const key = value ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }

  private getRoleAssumerArn() {
    return (
      process.env.SECURITY_HUB_ROLE_ASSUMER_ARN ??
      process.env.COMPCTL_AWS_ROLE_ASSUMER_ARN ??
      'arn:aws:iam::684120556289:role/roleAssumer'
    );
  }

  private getApiUrl() {
    return process.env.COMP_API_URL ?? 'http://localhost:3333';
  }

  private getAppUrl(organizationId: string) {
    const base =
      process.env.COMP_APP_URL ??
      process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
      'http://localhost:3000';
    return `${base.replace(/\/$/, '')}/${organizationId}`;
  }
}
