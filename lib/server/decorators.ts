const commandRegistry = new Map<DecoratorMetadataObject, Map<string, string>>();

export function command(name: string) {
  return function (
    _target: Function,
    context: ClassMethodDecoratorContext<any>
  ) {
    context.addInitializer(function () {
      const ctor = this.constructor;

      if (!commandRegistry.has(ctor)) {
        commandRegistry.set(ctor, new Map());
      }

      commandRegistry.get(ctor)!.set(name, context.name.toString());
    });
  };
}

export function getCommandMap(instance: any): Map<string, string> {
  return commandRegistry.get(instance.constructor) ?? new Map();
}
