import { App } from "./App";
import {
  AmbientLight,
  BoxBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  SpotLight
} from "three";
import { render } from "solid-js/web";
import { extend } from "../src";

extend({
  AmbientLight,
  BoxBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  SpotLight
});

render(() => <App />, document.getElementById("root")!);
