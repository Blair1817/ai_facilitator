export function shouldStubGlobalAttributes(instance) {
  return !instance?.token;
}

export function createPilotGlobalAttributes() {
  return {
    subscribe(observer) {
      const next =
        typeof observer === "function" ? observer : observer?.next?.bind(observer);
      // EmpiricaContext gates participant registration on this global. Tajriba
      // v1.12 production rejects the unauthenticated subscription that normally
      // supplies it, so the LAN pilot supplies only this minimal bootstrap
      // value. After registration, real game state uses the authenticated
      // TajribaParticipant `changes()` subscription and is not synthesized.
      next?.({
        attribute: {
          key: "experimentOpen",
          val: "true",
        },
        done: false,
      });
      next?.({ done: true });
      if (typeof observer !== "function") {
        observer?.complete?.();
      }
      return { unsubscribe() {} };
    },
  };
}
