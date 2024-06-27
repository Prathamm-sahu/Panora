import { LoggerService } from '@@core/@core-services/logger/logger.service';
import { PrismaService } from '@@core/@core-services/prisma/prisma.service';
import { BullQueueService } from '@@core/@core-services/queues/shared.service';
import { IBaseSync } from '@@core/utils/types/interface';
import { IngestDataService } from '@@core/@core-services/unification/ingest-data.service';
import { CoreSyncRegistry } from '@@core/@core-services/registries/core-sync.registry';
import { CoreUnification } from '@@core/@core-services/unification/core-unification.service';
import { FieldMappingService } from '@@core/field-mapping/field-mapping.service';
import { ApiResponse } from '@@core/utils/types';
import { OriginalActivityOutput } from '@@core/utils/types/original/original.ats';
import { AtsObject } from '@ats/@lib/@types';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ATS_PROVIDERS } from '@panora/shared';
import { ats_activities as AtsActivity } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { ServiceRegistry } from '../services/registry.service';
import { IActivityService } from '../types';
import { UnifiedActivityOutput } from '../types/model.unified';
import { WebhookService } from '@@core/@core-services/webhooks/panora-webhooks/webhook.service';

@Injectable()
export class SyncService implements OnModuleInit, IBaseSync {
  constructor(
    private prisma: PrismaService,
    private logger: LoggerService,
    private webhook: WebhookService,
    private fieldMappingService: FieldMappingService,
    private serviceRegistry: ServiceRegistry,
    private coreUnification: CoreUnification,
    private registry: CoreSyncRegistry,
    private bullQueueService: BullQueueService,
    private ingestService: IngestDataService,
  ) {
    this.logger.setContext(SyncService.name);
    this.registry.registerService('ats', 'activity', this);
  }

  async onModuleInit() {
    try {
      await this.bullQueueService.queueSyncJob(
        'ats-sync-activities',
        '0 0 * * *',
      );
    } catch (error) {
      throw error;
    }
  }

  //function used by sync worker which populate our ats_activities table
  //its role is to fetch all activities from providers 3rd parties and save the info inside our db
  // @Cron('*/2 * * * *') // every 2 minutes (for testing)
  @Cron('0 */8 * * *') // every 8 hours
  async syncActivities(user_id?: string) {
    try {
      this.logger.log(`Syncing activities....`);
      const users = user_id
        ? [
            await this.prisma.users.findUnique({
              where: {
                id_user: user_id,
              },
            }),
          ]
        : await this.prisma.users.findMany();
      if (users && users.length > 0) {
        for (const user of users) {
          const projects = await this.prisma.projects.findMany({
            where: {
              id_user: user.id_user,
            },
          });
          for (const project of projects) {
            const id_project = project.id_project;
            const linkedUsers = await this.prisma.linked_users.findMany({
              where: {
                id_project: id_project,
              },
            });
            linkedUsers.map(async (linkedUser) => {
              try {
                const providers = ATS_PROVIDERS;
                for (const provider of providers) {
                  try {
                    await this.syncActivitiesForLinkedUser(
                      provider,
                      linkedUser.id_linked_user,
                    );
                  } catch (error) {
                    throw error;
                  }
                }
              } catch (error) {
                throw error;
              }
            });
          }
        }
      }
    } catch (error) {
      throw error;
    }
  }

  //todo: HANDLE DATA REMOVED FROM PROVIDER
  async syncActivitiesForLinkedUser(
    integrationId: string,
    linkedUserId: string,
  ) {
    try {
      this.logger.log(
        `Syncing ${integrationId} activities for linkedUser ${linkedUserId}`,
      );
      // check if linkedUser has a connection if not just stop sync
      const connection = await this.prisma.connections.findFirst({
        where: {
          id_linked_user: linkedUserId,
          provider_slug: integrationId,
          vertical: 'ats',
        },
      });
      if (!connection) {
        this.logger.warn(
          `Skipping activities syncing... No ${integrationId} connection was found for linked user ${linkedUserId} `,
        );
      }
      // get potential fieldMappings and extract the original properties name
      const customFieldMappings =
        await this.fieldMappingService.getCustomFieldMappings(
          integrationId,
          linkedUserId,
          'ats.activity',
        );
      const remoteProperties: string[] = customFieldMappings.map(
        (mapping) => mapping.remote_id,
      );

      const service: IActivityService =
        this.serviceRegistry.getService(integrationId);
      if (!service) return;
      const resp: ApiResponse<OriginalActivityOutput[]> =
        await service.syncActivities(linkedUserId, remoteProperties);

      const sourceObject: OriginalActivityOutput[] = resp.data;

      await this.ingestService.ingestData<
        UnifiedActivityOutput,
        OriginalActivityOutput
      >(
        sourceObject,
        integrationId,
        connection.id_connection,
        'ats',
        'activity',
        customFieldMappings,
      );
    } catch (error) {
      throw error;
    }
  }

  async saveToDb(
    connection_id: string,
    linkedUserId: string,
    activities: UnifiedActivityOutput[],
    originSource: string,
    remote_data: Record<string, any>[],
  ): Promise<AtsActivity[]> {
    try {
      let activities_results: AtsActivity[] = [];
      for (let i = 0; i < activities.length; i++) {
        const activity = activities[i];
        const originId = activity.remote_id;

        if (!originId || originId == '') {
          throw new ReferenceError(`Origin id not there, found ${originId}`);
        }

        const existingActivity = await this.prisma.ats_activities.findFirst({
          where: {
            remote_id: originId,
            id_connection: connection_id,
          },
        });

        let unique_ats_activity_id: string;

        if (existingActivity) {
          // Update the existing activity
          let data: any = {
            modified_at: new Date(),
          };
          if (activity.activity_type) {
            data = { ...data, activity_type: activity.activity_type };
          }
          if (activity.body) {
            data = { ...data, activity_type: activity.body };
          }
          if (activity.remote_created_at) {
            data = { ...data, activity_type: activity.remote_created_at };
          }
          if (activity.subject) {
            data = { ...data, activity_type: activity.subject };
          }
          if (activity.visibility) {
            data = { ...data, activity_type: activity.visibility };
          }
          if (activity.candidate_id) {
            data = { ...data, id_ats_candidate: activity.candidate_id };
          }
          const res = await this.prisma.ats_activities.update({
            where: {
              id_ats_activity: existingActivity.id_ats_activity,
            },
            data: data,
          });
          unique_ats_activity_id = res.id_ats_activity;
          activities_results = [...activities_results, res];
        } else {
          // Create a new activity
          this.logger.log('activity not exists');
          const uuid = uuidv4();
          let data: any = {
            id_ats_activity: uuid,
            created_at: new Date(),
            modified_at: new Date(),
            remote_id: originId,
            id_connection: connection_id,
          };

          if (activity.activity_type) {
            data = { ...data, activity_type: activity.activity_type };
          }
          if (activity.body) {
            data = { ...data, activity_type: activity.body };
          }
          if (activity.remote_created_at) {
            data = { ...data, activity_type: activity.remote_created_at };
          }
          if (activity.subject) {
            data = { ...data, activity_type: activity.subject };
          }
          if (activity.visibility) {
            data = { ...data, activity_type: activity.visibility };
          }
          if (activity.candidate_id) {
            data = { ...data, id_ats_candidate: activity.candidate_id };
          }

          const newActivity = await this.prisma.ats_activities.create({
            data: data,
          });

          unique_ats_activity_id = newActivity.id_ats_activity;
          activities_results = [...activities_results, newActivity];
        }

        // check duplicate or existing values
        if (activity.field_mappings && activity.field_mappings.length > 0) {
          const entity = await this.prisma.entity.create({
            data: {
              id_entity: uuidv4(),
              ressource_owner_id: unique_ats_activity_id,
            },
          });

          for (const [slug, value] of Object.entries(activity.field_mappings)) {
            const attribute = await this.prisma.attribute.findFirst({
              where: {
                slug: slug,
                source: originSource,
                id_consumer: linkedUserId,
              },
            });

            if (attribute) {
              await this.prisma.value.create({
                data: {
                  id_value: uuidv4(),
                  data: value || 'null',
                  attribute: {
                    connect: {
                      id_attribute: attribute.id_attribute,
                    },
                  },
                  entity: {
                    connect: {
                      id_entity: entity.id_entity,
                    },
                  },
                },
              });
            }
          }
        }

        //insert remote_data in db
        await this.prisma.remote_data.upsert({
          where: {
            ressource_owner_id: unique_ats_activity_id,
          },
          create: {
            id_remote_data: uuidv4(),
            ressource_owner_id: unique_ats_activity_id,
            format: 'json',
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
          update: {
            data: JSON.stringify(remote_data[i]),
            created_at: new Date(),
          },
        });
      }
      return activities_results;
    } catch (error) {
      throw error;
    }
  }
}
