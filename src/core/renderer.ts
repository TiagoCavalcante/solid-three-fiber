import * as THREE from "three";
import { StoreApi as UseStore } from "zustand/vanilla";
import {
  is,
  prepare,
  diffProps,
  DiffSet,
  applyProps,
  updateInstance,
  invalidateInstance,
  attach,
  detach,
  applyProp
} from "./utils";
import { RootState } from "./store";
import { EventHandlers, removeInteractivity } from "./events";
import { log } from "../solid";
import { dispose } from ".";

export type Root = { store: UseStore<RootState>; };

export type LocalState = {
  root: UseStore<RootState>;
  // objects and parent are used when children are added with `attach` instead of being added to the Object3D scene graph
  objects: Instance[];
  parent: Instance | null;
  primitive?: boolean;
  eventCount: number;
  handlers: Partial<EventHandlers>;
  attach?: AttachType;
  previousAttach?: any;
  memoizedProps: {
    [key: string]: any;
  };
};

export type AttachFnType = (parent: Instance, self: Instance) => void;
export type AttachType = string | [attach: string | AttachFnType, detach: string | AttachFnType];

// This type clamps down on a couple of assumptions that we can make regarding native types, which
// could anything from scene objects, THREE.Objects, JSM, user-defined classes and non-scene objects.
// What they all need to have in common is defined here ...
export type BaseInstance = Omit<
  THREE.Object3D,
  "children" | "attach" | "add" | "remove" | "raycast"
> & {
  __r3f: LocalState;
  children: Instance[];
  remove: (...object: Instance[]) => Instance;
  add: (...object: Instance[]) => Instance;
  raycast?: (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => void;
};
export type Instance = BaseInstance & { [key: string]: any; };

export type InstanceProps = {
  [key: string]: unknown;
} & {
  args?: any[];
  object?: object;
  visible?: boolean;
  dispose?: null;
  attach?: AttachType;
};

interface Catalogue {
  [name: string]: {
    new(...args: any): Instance;
  };
}

// Type guard to tell a store from a portal
const isStore = (def: any): def is UseStore<RootState> =>
  def && !!(def as UseStore<RootState>).getState;
// const getContainer = (
//   container: UseStore<RootState> | Instance,
//   child: Instance
// ) => ({
//   // If the container is not a root-store then it must be a THREE.Object3D into which part of the
//   // scene is portalled into. Now there can be two variants of this, either that object is part of
//   // the regular jsx tree, in which case it already has __r3f with a valid root attached, or it lies
//   // outside react, in which case we must take the root of the child that is about to be attached to it.
//   root: isStore(container)
//     ? container
//     : container.__r3f?.root ?? child.__r3f.root,
//   // The container is the eventual target into which objects are mounted, it has to be a THREE.Object3D
//   container: isStore(container)
//     ? (container.getState().scene as unknown as Instance)
//     : container,
// });

export let catalogue: Catalogue = {};
let extend = (objects: object): void => void (catalogue = { ...catalogue, ...objects });

function createThreeRenderer<TCanvas>(roots: Map<TCanvas, Root>, getEventPriority?: () => any) {
  function createInstance(
    type: string,
    { args = [], attach, ...props }: InstanceProps,
    root: UseStore<RootState> | Instance
  ) {
    let name = `${type[0].toUpperCase()}${type.slice(1)}`;
    let instance: Instance;

    // https://github.com/facebook/react/issues/17147
    // Portals do not give us a root, they are themselves treated as a root by the reconciler
    // In order to figure out the actual root we have to climb through fiber internals :(
    // if (!isStore(root) && internalInstanceHandle) {
    //   const fn = (node: Reconciler.Fiber): UseStore<RootState> => {
    //     if (!node.return) return node.stateNode && node.stateNode.containerInfo;
    //     else return fn(node.return);
    //   };
    //   root = fn(internalInstanceHandle);
    // }
    // Assert that by now we have a valid root
    if (!root || !isStore(root)) throw `No valid root for ${name}!`;

    // Auto-attach geometries and materials
    if (attach === undefined) {
      if (name.endsWith("Geometry")) attach = "geometry";
      else if (name.endsWith("Material")) attach = "material";
    }

    if (type === "primitive") {
      if (props.object === undefined) throw `Primitives without 'object' are invalid!`;
      const object = props.object as Instance;
      instance = prepare<Instance>(object, {
        root,
        attach,
        primitive: true
      });
    } else {
      const target = catalogue[name];
      if (!target) {
        throw `${name} is not part of the THREE namespace! Did you forget to extend? See: https://github.com/pmndrs/react-three-fiber/blob/master/markdown/api.md#using-3rd-party-objects-declaratively`;
      }

      // Throw if an object or literal was passed for args
      if (!Array.isArray(args)) throw "The args prop must be an array!";

      // Instanciate new object, link it to the root
      // Append memoized props with args so it's not forgotten
      instance = prepare(new target(...args), {
        root,
        attach,
        // TODO: Figure out what this is for
        memoizedProps: { args: args.length === 0 ? null : args }
      });
    }

    // It should NOT call onUpdate on object instanciation, because it hasn't been added to the
    // view yet. If the callback relies on references for instance, they won't be ready yet, this is
    // why it passes "true" here
    applyProps(instance, props);
    return instance;
  }

  function appendChild(parentInstance: Instance, child: Instance) {
    let added = false;
    if (child) {
      // The attach attribute implies that the object attaches itself on the parent
      if (child.__r3f.attach) {
        attach(parentInstance, child, child.__r3f.attach);
      } else if (child.isObject3D && parentInstance.isObject3D) {
        // add in the usual parent-child way
        parentInstance.add(child);
        added = true;
      }
      // This is for anything that used attach, and for non-Object3Ds that don't get attached to props;
      // that is, anything that's a child in React but not a child in the scenegraph.
      if (!added) parentInstance.__r3f.objects.push(child);
      if (!child.__r3f) prepare(child, {});
      child.__r3f.parent = parentInstance;
      updateInstance(child);
      invalidateInstance(child);
    }
  }

  function insertBefore(parentInstance: Instance, child: Instance, beforeChild: Instance) {
    let added = false;
    if (child) {
      if (child.__r3f.attach) {
        attach(parentInstance, child, child.__r3f.attach);
      } else if (child.isObject3D && parentInstance.isObject3D) {
        child.parent = parentInstance as unknown as THREE.Object3D;
        child.dispatchEvent({ type: "added" });
        const restSiblings = parentInstance.children.filter(sibling => sibling !== child);
        const index = restSiblings.indexOf(beforeChild);
        parentInstance.children = [
          ...restSiblings.slice(0, index),
          child,
          ...restSiblings.slice(index)
        ];
        added = true;
      }

      if (!added) parentInstance.__r3f.objects.push(child);
      if (!child.__r3f) prepare(child, {});
      child.__r3f.parent = parentInstance;
      updateInstance(child);
      invalidateInstance(child);
    }
  }

  function removeRecursive(array: Instance[], parent: Instance, dispose: boolean = false) {
    if (array) [...array].forEach(child => removeChild(parent, child, dispose));
  }

  function removeChild(parentInstance: Instance, child: Instance, canDispose?: boolean) {
    if (child) {
      // Clear the parent reference
      if (child.__r3f) child.__r3f.parent = null;
      // Remove child from the parents objects
      if (parentInstance.__r3f?.objects)
        parentInstance.__r3f.objects = parentInstance.__r3f.objects.filter(x => x !== child);
      // Remove attachment
      if (child.__r3f?.attach) {
        detach(parentInstance, child, child.__r3f.attach);
      } else if (child.isObject3D && parentInstance.isObject3D) {
        log("three", "removeObject", parentInstance, child);
        parentInstance.remove(child);
        // Remove interactivity
        if (child.__r3f?.root) {
          removeInteractivity(child.__r3f.root, child as unknown as THREE.Object3D);
        }
      }

      // Allow objects to bail out of recursive dispose alltogether by passing dispose={null}
      // Never dispose of primitives because their state may be kept outside of React!
      // In order for an object to be able to dispose it has to have
      //   - a dispose method,
      //   - it cannot be a <primitive object={...} />
      //   - it cannot be a THREE.Scene, because three has broken it's own api
      //
      // Since disposal is recursive, we can check the optional dispose arg, which will be undefined
      // when the reconciler calls it, but then carry our own check recursively
      const isPrimitive = child.__r3f?.primitive;
      const shouldDispose =
        canDispose === undefined ? child.dispose !== null && !isPrimitive : canDispose;

      // Remove nested child objects. Primitives should not have objects and children that are
      // attached to them declaratively ...
      if (!isPrimitive) {
        removeRecursive(child.__r3f?.objects, child, shouldDispose);
        removeRecursive(child.children, child, shouldDispose);
      }

      // Remove references
      if (child.__r3f) {
        delete ((child as Partial<Instance>).__r3f as Partial<LocalState>).root;
        delete ((child as Partial<Instance>).__r3f as Partial<LocalState>).objects;
        delete ((child as Partial<Instance>).__r3f as Partial<LocalState>).handlers;
        delete ((child as Partial<Instance>).__r3f as Partial<LocalState>).memoizedProps;
        if (!isPrimitive) delete (child as Partial<Instance>).__r3f;
      }

      // Dispose item whenever the reconciler feels like it
      if (shouldDispose && child.type !== "Scene") {
        // scheduleCallback(idlePriority, () => {
        log("three", "dispose", child);
        child.dispose?.();
        dispose(child);
        // });
      }

      invalidateInstance(parentInstance);
    }
  }

  function switchInstance(instance: Instance, type: string, newProps: InstanceProps) {
    const parent = instance.__r3f?.parent;
    if (!parent) return;

    const newInstance = createInstance(type, newProps, instance.__r3f.root);

    // https://github.com/pmndrs/react-three-fiber/issues/1348
    // When args change the instance has to be re-constructed, which then
    // forces r3f to re-parent the children and non-scene objects
    // This can not include primitives, which should not have declarative children
    if (type !== "primitive" && instance.children) {
      instance.children.forEach(child => appendChild(newInstance, child));
      instance.children = [];
    }

    instance.__r3f.objects.forEach(child => appendChild(newInstance, child));
    instance.__r3f.objects = [];

    removeChild(parent, instance);
    appendChild(parent, newInstance);

    // This evil hack switches the react-internal fiber node
    // https://github.com/facebook/react/issues/14983
    // https://github.com/facebook/react/pull/15021
    // [fiber, fiber.alternate].forEach((fiber) => {
    //   if (fiber !== null) {
    //     fiber.stateNode = newInstance;
    //     if (fiber.ref) {
    //       if (typeof fiber.ref === "function")
    //         (fiber as unknown as any).ref(newInstance);
    //       else (fiber.ref as Reconciler.RefObject).current = newInstance;
    //     }
    //   }
    // });
  }

  return {
    applyProps,
    applyProp,
    appendChild,
    createInstance,
    switchInstance,
    insertBefore,
    removeChild,
    removeRecursive,
    attach
  };
}
export type ThreeRenderer = ReturnType<typeof createThreeRenderer>;

export { prepare, createThreeRenderer, extend };
