// deno-lint-ignore-file no-explicit-any
import { generate as generateUUID } from "@std/uuid/v7";

interface QueueItem<ReturnType> {
  title: string;
  type: string;
  subtitle?: string;
  description?: string;

  customErrorTitle?: string;

  notifyOnFinish: boolean;

  promise: Promise<ReturnType>;
  onComplete?: (returnVal: ReturnType) => void;
  onFailure?: () => void;

  startDate: Date;
  itemUUID: string;
}
type StubQueueItem = Omit<Omit<QueueItem<any>, "startDate">, "itemUUID">;

interface QueueNotification {
  title: string;
  subtitle?: string;
  description?: string;

  isException: boolean;
  date: Date;
  itemUUID: string;
}

type StubQueueNotification = Omit<Omit<QueueNotification, "date">, "itemUUID">;

export class QueueManager {
  readonly entries: QueueItem<any>[] = [];
  private _notifications: QueueNotification[] = [];
  get notifications() {
    return this._notifications;
  }

  onQueueAdded: undefined | ((item: QueueItem<any>) => void);
  onNotificationAdded: undefined | ((item: QueueNotification) => void);

  scheduleTask(stubTask: StubQueueItem) {
    const task = stubTask as QueueItem<any>;
    task.startDate = new Date();
    task.itemUUID = generateUUID();

    // TODO: Implement that finished tasks will get removed

    const defaultFinishDesc =
      `Started: ${task.startDate.toLocaleTimeString()}; ` + task.description
        ? "Original description: " + task.description
        : "<task had no description>";

    // Handle onComplete
    task.promise.then((value) => {
      if (task.notifyOnFinish) {
        this.addNotification({
          title: `Task "${task.title}" has completed`,
          subtitle: task.subtitle,
          description: defaultFinishDesc,
          isException: false,
        });
      }

      if (task.onComplete) {
        task.onComplete(value);
      }
    });

    // Handle exceptions
    task.promise.catch((error: unknown) => {
      this.addNotification({
        title: `"${task.type}" task failed`,
        subtitle:
          task.customErrorTitle ?? `${error} occured in task "${task.title}"`,
        description: defaultFinishDesc,
        isException: true,
      });

      if (task.onFailure) {
        task.onFailure();
      }
    });

    this.entries.push(task);
    this.onQueueAdded?.(task);
  }

  addNotification(stubNotifaction: StubQueueNotification) {
    const notification = stubNotifaction as QueueNotification;
    notification.date = new Date();
    notification.itemUUID = generateUUID();

    this._notifications.push(notification);
    this.onNotificationAdded?.(notification);
  }

  removeNotification(uuid: string) {
    this._notifications = this._notifications.filter(
      (i) => i.itemUUID === uuid,
    );
  }
}
