/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { Realm } from "../realm.js";
import type { Effects } from "../realm";
import type { Descriptor, PropertyBinding } from "../types.js";
import { IsArray, Get } from "../methods/index.js";
import {
  BoundFunctionValue,
  ProxyValue,
  SymbolValue,
  NumberValue,
  StringValue,
  BooleanValue,
  AbstractValue,
  EmptyValue,
  FunctionValue,
  ECMAScriptSourceFunctionValue,
  Value,
  ObjectValue,
  NativeFunctionValue,
  UndefinedValue,
} from "../values/index.js";
import * as t from "babel-types";
import type {
  BabelNodeExpression,
  BabelNodeStatement,
  BabelNodeIdentifier,
  BabelNodeBlockStatement,
  BabelNodeLVal,
  BabelNodeMemberExpression,
  BabelVariableKind,
  BabelNodeFile,
  BabelNodeFunctionExpression,
} from "babel-types";
import { Generator, PreludeGenerator, NameGenerator } from "../utils/generator.js";
import type { SerializationContext } from "../utils/generator.js";
import invariant from "../invariant.js";
import type {
  ResidualFunctionBinding,
  FunctionInfo,
  FunctionInstance,
  AdditionalFunctionInfo,
  ReactSerializerState,
  SerializedBody,
  ClassMethodInstance,
  AdditionalFunctionEffects,
} from "./types.js";
import type { SerializerOptions } from "../options.js";
import { TimingStatistics, SerializerStatistics, BodyReference } from "./types.js";
import { Logger } from "../utils/logger.js";
import { Modules } from "../utils/modules.js";
import { ResidualHeapInspector } from "./ResidualHeapInspector.js";
import { ResidualFunctions } from "./ResidualFunctions.js";
import type { Scope } from "./ResidualHeapVisitor.js";
import { factorifyObjects } from "./factorify.js";
import { voidExpression, emptyExpression, constructorExpression, protoExpression } from "../utils/internalizer.js";
import { Emitter } from "./Emitter.js";
import { ResidualHeapValueIdentifiers } from "./ResidualHeapValueIdentifiers.js";
import {
  commonAncestorOf,
  getSuggestedArrayLiteralLength,
  withDescriptorValue,
  ClassPropertiesToIgnore,
  canIgnoreClassLengthProperty,
  getObjectPrototypeMetadata,
} from "./utils.js";
import { CompilerDiagnostic, FatalError } from "../errors.js";
import { canHoistFunction } from "../react/hoisting.js";
import { To } from "../singletons.js";
import { ResidualReactElementSerializer } from "./ResidualReactElementSerializer.js";
import type { Binding } from "../environment.js";
import { DeclarativeEnvironmentRecord } from "../environment.js";
import type { Referentializer } from "./Referentializer.js";

function commentStatement(text: string) {
  let s = t.emptyStatement();
  s.leadingComments = [({ type: "BlockComment", value: text }: any)];
  return s;
}

export class ResidualHeapSerializer {
  constructor(
    realm: Realm,
    logger: Logger,
    modules: Modules,
    residualHeapValueIdentifiers: ResidualHeapValueIdentifiers,
    residualHeapInspector: ResidualHeapInspector,
    residualValues: Map<Value, Set<Scope>>,
    residualFunctionInstances: Map<FunctionValue, FunctionInstance>,
    residualClassMethodInstances: Map<FunctionValue, ClassMethodInstance>,
    residualFunctionInfos: Map<BabelNodeBlockStatement, FunctionInfo>,
    options: SerializerOptions,
    referencedDeclaredValues: Map<AbstractValue, void | FunctionValue>,
    additionalFunctionValuesAndEffects: Map<FunctionValue, AdditionalFunctionEffects> | void,
    additionalFunctionValueInfos: Map<FunctionValue, AdditionalFunctionInfo>,
    declarativeEnvironmentRecordsBindings: Map<DeclarativeEnvironmentRecord, Map<string, ResidualFunctionBinding>>,
    statistics: SerializerStatistics,
    react: ReactSerializerState,
    referentializer: Referentializer,
    generatorParents: Map<Generator, Generator>
  ) {
    this.realm = realm;
    this.logger = logger;
    this.modules = modules;
    this.residualHeapValueIdentifiers = residualHeapValueIdentifiers;
    this.statistics = statistics;
    this.react = react;
    this.referentializer = referentializer;

    let realmGenerator = this.realm.generator;
    invariant(realmGenerator);
    this.generator = realmGenerator;
    let realmPreludeGenerator = this.realm.preludeGenerator;
    invariant(realmPreludeGenerator);
    this.preludeGenerator = realmPreludeGenerator;

    this.prelude = [];
    this._descriptors = new Map();
    this.needsEmptyVar = false;
    this.needsAuxiliaryConstructor = false;
    this.descriptorNameGenerator = this.preludeGenerator.createNameGenerator("$$");
    this.factoryNameGenerator = this.preludeGenerator.createNameGenerator("$_");
    this.intrinsicNameGenerator = this.preludeGenerator.createNameGenerator("$i_");
    this.functionNameGenerator = this.preludeGenerator.createNameGenerator("$f_");
    this.initializeConditionNameGenerator = this.preludeGenerator.createNameGenerator("_initialized");
    this.requireReturns = new Map();
    this.serializedValues = new Set();
    this._serializedValueWithIdentifiers = new Set();
    this.additionalFunctionValueNestedFunctions = new Set();
    this.residualReactElementSerializer = new ResidualReactElementSerializer(this.realm, this);
    this.residualFunctions = new ResidualFunctions(
      this.realm,
      this.statistics,
      options,
      this.modules,
      this.requireReturns,
      {
        getLocation: value => this.getSerializeObjectIdentifier(value),
        createLocation: () => {
          let location = t.identifier(this.initializeConditionNameGenerator.generate());
          // TODO: This function may get to create locations to be used in additional functions; is the global prelude the right place?
          this.prelude.push(t.variableDeclaration("var", [t.variableDeclarator(location)]));
          return location;
        },
      },
      this.prelude,
      this.preludeGenerator.createNameGenerator("__init_"),
      this.factoryNameGenerator,
      residualFunctionInfos,
      residualFunctionInstances,
      residualClassMethodInstances,
      additionalFunctionValueInfos,
      this.additionalFunctionValueNestedFunctions,
      referentializer
    );
    this.emitter = new Emitter(this.residualFunctions, referencedDeclaredValues);
    this.mainBody = this.emitter.getBody();
    this.residualHeapInspector = residualHeapInspector;
    this.residualValues = residualValues;
    this.residualFunctionInstances = residualFunctionInstances;
    this.residualClassMethodInstances = residualClassMethodInstances;
    this.residualFunctionInfos = residualFunctionInfos;
    this._options = options;
    this.referencedDeclaredValues = referencedDeclaredValues;
    this.activeGeneratorBodies = new Map();
    this.additionalFunctionValuesAndEffects = additionalFunctionValuesAndEffects;
    this.additionalFunctionValueInfos = additionalFunctionValueInfos;
    this.rewrittenAdditionalFunctions = new Map();
    this.declarativeEnvironmentRecordsBindings = declarativeEnvironmentRecordsBindings;
    this.getGeneratorParent = generatorParents.get.bind(generatorParents);
    this.additionalFunctionGenerators = new Map();
    this.additionalFunctionGeneratorsInverse = new Map();
  }

  emitter: Emitter;
  functions: Map<BabelNodeBlockStatement, Array<FunctionInstance>>;
  functionInstances: Array<FunctionInstance>;
  prelude: Array<BabelNodeStatement>;
  body: Array<BabelNodeStatement>;
  mainBody: SerializedBody;
  realm: Realm;
  preludeGenerator: PreludeGenerator;
  generator: Generator;
  _descriptors: Map<string, BabelNodeIdentifier>;
  needsEmptyVar: boolean;
  needsAuxiliaryConstructor: boolean;
  descriptorNameGenerator: NameGenerator;
  factoryNameGenerator: NameGenerator;
  intrinsicNameGenerator: NameGenerator;
  functionNameGenerator: NameGenerator;
  initializeConditionNameGenerator: NameGenerator;
  logger: Logger;
  modules: Modules;
  residualHeapValueIdentifiers: ResidualHeapValueIdentifiers;
  requireReturns: Map<number | string, BabelNodeExpression>;
  statistics: SerializerStatistics;
  timingStats: TimingStatistics;
  residualHeapInspector: ResidualHeapInspector;
  residualValues: Map<Value, Set<Scope>>;
  residualFunctionInstances: Map<FunctionValue, FunctionInstance>;
  residualClassMethodInstances: Map<FunctionValue, ClassMethodInstance>;
  residualFunctionInfos: Map<BabelNodeBlockStatement, FunctionInfo>;
  serializedValues: Set<Value>;
  _serializedValueWithIdentifiers: Set<Value>;
  residualFunctions: ResidualFunctions;
  _options: SerializerOptions;
  referencedDeclaredValues: Map<AbstractValue, void | FunctionValue>;
  activeGeneratorBodies: Map<Generator, SerializedBody>;
  additionalFunctionValuesAndEffects: Map<FunctionValue, AdditionalFunctionEffects> | void;
  additionalFunctionValueInfos: Map<FunctionValue, AdditionalFunctionInfo>;
  rewrittenAdditionalFunctions: Map<FunctionValue, Array<BabelNodeStatement>>;
  declarativeEnvironmentRecordsBindings: Map<DeclarativeEnvironmentRecord, Map<string, ResidualFunctionBinding>>;
  react: ReactSerializerState;
  residualReactElementSerializer: ResidualReactElementSerializer;
  referentializer: Referentializer;
  additionalFunctionGenerators: Map<FunctionValue, Generator>;
  additionalFunctionGeneratorsInverse: Map<Generator, FunctionValue>;

  // function values nested in additional functions can't delay initializations
  // TODO: revisit this and fix additional functions to be capable of delaying initializations
  additionalFunctionValueNestedFunctions: Set<FunctionValue>;

  getGeneratorParent: Generator => void | Generator;

  // Configures all mutable aspects of an object, in particular:
  // symbols, properties, prototype.
  // For every created object that corresponds to a value,
  // this function should be invoked once.
  // Thus, as a side effect, we gather statistics here on all emitted objects.
  _emitObjectProperties(
    obj: ObjectValue,
    properties: Map<string, PropertyBinding> = obj.properties,
    objectPrototypeAlreadyEstablished: boolean = false,
    cleanupDummyProperties: ?Set<string>,
    skipPrototype: boolean = false
  ) {
    //inject symbols
    for (let [symbol, propertyBinding] of obj.symbols) {
      invariant(propertyBinding);
      let desc = propertyBinding.descriptor;
      if (desc === undefined) continue; //deleted
      this.emitter.emitNowOrAfterWaitingForDependencies(this._getDescriptorValues(desc).concat([symbol, obj]), () => {
        invariant(desc !== undefined);
        return this._emitProperty(obj, symbol, desc);
      });
    }

    // inject properties
    for (let [key, propertyBinding] of properties) {
      invariant(propertyBinding);
      if (propertyBinding.pathNode !== undefined) continue; // Property is assigned to inside loop
      let desc = propertyBinding.descriptor;
      if (desc === undefined) continue; //deleted
      if (this.residualHeapInspector.canIgnoreProperty(obj, key)) continue;
      invariant(desc !== undefined);
      this.emitter.emitNowOrAfterWaitingForDependencies(this._getDescriptorValues(desc).concat(obj), () => {
        invariant(desc !== undefined);
        return this._emitProperty(obj, key, desc, cleanupDummyProperties != null && cleanupDummyProperties.has(key));
      });
    }

    // inject properties with computed names
    if (obj.unknownProperty !== undefined) {
      let desc = obj.unknownProperty.descriptor;
      if (desc !== undefined) {
        let val = desc.value;
        invariant(val instanceof AbstractValue);
        this.emitter.emitNowOrAfterWaitingForDependencies(this._getNestedAbstractValues(val, [obj]), () => {
          invariant(val instanceof AbstractValue);
          this._emitPropertiesWithComputedNames(obj, val);
        });
      }
    }

    // prototype
    if (!skipPrototype) {
      this._emitObjectPrototype(obj, objectPrototypeAlreadyEstablished);
      if (obj instanceof FunctionValue) this._emitConstructorPrototype(obj);
    }

    this.statistics.objects++;
    this.statistics.objectProperties += obj.properties.size;
  }

  _emitObjectPrototype(obj: ObjectValue, objectPrototypeAlreadyEstablished: boolean) {
    let kind = obj.getKind();
    let proto = obj.$Prototype;
    if (objectPrototypeAlreadyEstablished) {
      // Emitting an assertion. This can be removed in the future, or put under a DEBUG flag.
      this.emitter.emitNowOrAfterWaitingForDependencies([proto, obj], () => {
        invariant(proto);
        let serializedProto = this.serializeValue(proto);
        let uid = this.getSerializeObjectIdentifier(obj);
        const fetchedPrototype =
          this.realm.isCompatibleWith(this.realm.MOBILE_JSC_VERSION) || this.realm.isCompatibleWith("mobile")
            ? t.memberExpression(uid, protoExpression)
            : t.callExpression(this.preludeGenerator.memoizeReference("Object.getPrototypeOf"), [uid]);
        let condition = t.binaryExpression("!==", fetchedPrototype, serializedProto);
        let throwblock = t.blockStatement([
          t.throwStatement(t.newExpression(t.identifier("Error"), [t.stringLiteral("unexpected prototype")])),
        ]);
        this.emitter.emit(t.ifStatement(condition, throwblock));
      });
      return;
    }
    if (proto === this.realm.intrinsics[kind + "Prototype"]) return;

    this.emitter.emitNowOrAfterWaitingForDependencies([proto, obj], () => {
      invariant(proto);
      let serializedProto = this.serializeValue(proto);
      let uid = this.getSerializeObjectIdentifier(obj);
      if (!this.realm.isCompatibleWith(this.realm.MOBILE_JSC_VERSION) && !this.realm.isCompatibleWith("mobile"))
        this.emitter.emit(
          t.expressionStatement(
            t.callExpression(this.preludeGenerator.memoizeReference("Object.setPrototypeOf"), [uid, serializedProto])
          )
        );
      else {
        this.emitter.emit(
          t.expressionStatement(t.assignmentExpression("=", t.memberExpression(uid, protoExpression), serializedProto))
        );
      }
    });
  }

  _emitConstructorPrototype(func: FunctionValue) {
    // If the original prototype object was mutated,
    // request its serialization here as this might be observable by
    // residual code.
    let prototype = ResidualHeapInspector.getPropertyValue(func, "prototype");
    if (prototype instanceof ObjectValue && this.residualValues.has(prototype)) {
      this.emitter.emitNowOrAfterWaitingForDependencies([func], () => {
        invariant(prototype instanceof Value);
        this.serializeValue(prototype);
      });
    }
  }

  _getNestedAbstractValues(absVal: AbstractValue, values: Array<Value>): Array<Value> {
    if (absVal.kind === "widened property") return values;
    invariant(absVal.args.length === 3);
    let cond = absVal.args[0];
    invariant(cond instanceof AbstractValue);
    if (cond.kind === "template for property name condition") {
      let P = cond.args[0];
      values.push(P);
      let V = absVal.args[1];
      values.push(V);
      let W = absVal.args[2];
      if (W instanceof AbstractValue) this._getNestedAbstractValues(W, values);
      else values.push(W);
    } else {
      // conditional assignment
      values.push(cond);
      let consequent = absVal.args[1];
      invariant(consequent instanceof AbstractValue);
      let alternate = absVal.args[2];
      invariant(alternate instanceof AbstractValue);
      this._getNestedAbstractValues(consequent, values);
      this._getNestedAbstractValues(alternate, values);
    }
    return values;
  }

  _emitPropertiesWithComputedNames(obj: ObjectValue, absVal: AbstractValue) {
    if (absVal.kind === "widened property") return;
    invariant(absVal.args.length === 3);
    let cond = absVal.args[0];
    invariant(cond instanceof AbstractValue);
    if (cond.kind === "template for property name condition") {
      let P = cond.args[0];
      invariant(P instanceof AbstractValue);
      let V = absVal.args[1];
      let earlier_props = absVal.args[2];
      if (earlier_props instanceof AbstractValue) this._emitPropertiesWithComputedNames(obj, earlier_props);
      let uid = this.getSerializeObjectIdentifier(obj);
      let serializedP = this.serializeValue(P);
      let serializedV = this.serializeValue(V);
      this.emitter.emit(
        t.expressionStatement(t.assignmentExpression("=", t.memberExpression(uid, serializedP, true), serializedV))
      );
    } else {
      // conditional assignment
      let serializedCond = this.serializeValue(cond);
      let consequent = absVal.args[1];
      invariant(consequent instanceof AbstractValue);
      let alternate = absVal.args[2];
      invariant(alternate instanceof AbstractValue);
      let oldBody = this.emitter.beginEmitting(
        "consequent",
        {
          type: "ConditionalAssignmentBranch",
          parentBody: undefined,
          entries: [],
          done: false,
        },
        /*isChild*/ true
      );
      this._emitPropertiesWithComputedNames(obj, consequent);
      let consequentBody = this.emitter.endEmitting("consequent", oldBody, /*isChild*/ true);
      let consequentStatement = t.blockStatement(consequentBody.entries);
      oldBody = this.emitter.beginEmitting(
        "alternate",
        {
          type: "ConditionalAssignmentBranch",
          parentBody: undefined,
          entries: [],
          done: false,
        },
        /*isChild*/ true
      );
      this._emitPropertiesWithComputedNames(obj, alternate);
      let alternateBody = this.emitter.endEmitting("alternate", oldBody, /*isChild*/ true);
      let alternateStatement = t.blockStatement(alternateBody.entries);
      this.emitter.emit(t.ifStatement(serializedCond, consequentStatement, alternateStatement));
    }
  }

  // Overridable.
  getSerializeObjectIdentifier(val: Value) {
    return this.residualHeapValueIdentifiers.getIdentifierAndIncrementReferenceCount(val);
  }

  _emitProperty(
    val: ObjectValue,
    key: string | SymbolValue,
    desc: Descriptor | void,
    deleteIfMightHaveBeenDeleted: boolean = false
  ): void {
    // Location for the property to be assigned to
    let locationFunction = () => {
      let serializedKey =
        key instanceof SymbolValue ? this.serializeValue(key) : this.generator.getAsPropertyNameExpression(key);
      let computed = key instanceof SymbolValue || !t.isIdentifier(serializedKey);
      return t.memberExpression(this.getSerializeObjectIdentifier(val), serializedKey, computed);
    };
    if (desc === undefined) {
      this._deleteProperty(locationFunction());
    } else {
      this.emitter.emit(this.emitDefinePropertyBody(deleteIfMightHaveBeenDeleted, locationFunction, val, key, desc));
    }
  }

  emitDefinePropertyBody(
    deleteIfMightHaveBeenDeleted: boolean,
    locationFunction: void | (() => BabelNodeLVal),
    val: ObjectValue,
    key: string | SymbolValue,
    desc: Descriptor
  ): BabelNodeStatement {
    if (desc.joinCondition) {
      let cond = this.serializeValue(desc.joinCondition);
      invariant(cond !== undefined);
      let trueBody;
      let falseBody;
      if (desc.descriptor1)
        trueBody = this.emitDefinePropertyBody(
          deleteIfMightHaveBeenDeleted,
          locationFunction,
          val,
          key,
          desc.descriptor1
        );
      if (desc.descriptor2)
        falseBody = this.emitDefinePropertyBody(
          deleteIfMightHaveBeenDeleted,
          locationFunction,
          val,
          key,
          desc.descriptor2
        );
      if (trueBody && falseBody) return t.ifStatement(cond, trueBody, falseBody);
      if (trueBody) return t.ifStatement(cond, trueBody);
      if (falseBody) return t.ifStatement(t.unaryExpression("!", cond), falseBody);
      invariant(false);
    }
    if (locationFunction !== undefined && this._canEmbedProperty(val, key, desc)) {
      let descValue = desc.value;
      invariant(descValue instanceof Value);
      invariant(!this.emitter.getReasonToWaitForDependencies([descValue, val]), "precondition of _emitProperty");
      let mightHaveBeenDeleted = descValue.mightHaveBeenDeleted();
      // The only case we do not need to remove the dummy property is array index property.
      return this._getPropertyAssignment(
        locationFunction,
        () => {
          invariant(descValue instanceof Value);
          return this.serializeValue(descValue);
        },
        mightHaveBeenDeleted,
        deleteIfMightHaveBeenDeleted
      );
    }
    let body = [];
    let descProps = [];
    let boolKeys = ["enumerable", "configurable"];
    let valKeys = [];

    if (!desc.get && !desc.set) {
      boolKeys.push("writable");
      valKeys.push("value");
    } else {
      valKeys.push("set", "get");
    }

    let descriptorsKey = [];
    for (let boolKey of boolKeys) {
      if (boolKey in desc) {
        let b = desc[boolKey];
        invariant(b !== undefined);
        descProps.push(t.objectProperty(t.identifier(boolKey), t.booleanLiteral(b)));
        descriptorsKey.push(`${boolKey}:${b.toString()}`);
      }
    }

    descriptorsKey = descriptorsKey.join(",");
    let descriptorId = this._descriptors.get(descriptorsKey);
    if (descriptorId === undefined) {
      descriptorId = t.identifier(this.descriptorNameGenerator.generate(descriptorsKey));
      let declar = t.variableDeclaration("var", [t.variableDeclarator(descriptorId, t.objectExpression(descProps))]);
      // The descriptors are used across all scopes, and thus must be declared in the prelude.
      this.prelude.push(declar);
      this._descriptors.set(descriptorsKey, descriptorId);
    }
    invariant(descriptorId !== undefined);

    for (let descKey of valKeys) {
      if (descKey in desc) {
        let descValue = desc[descKey];
        invariant(descValue instanceof Value);
        if (descValue instanceof UndefinedValue) {
          this.serializeValue(descValue);
          continue;
        }
        invariant(!this.emitter.getReasonToWaitForDependencies([descValue]), "precondition of _emitProperty");
        body.push(
          t.assignmentExpression(
            "=",
            t.memberExpression(descriptorId, t.identifier(descKey)),
            this.serializeValue(descValue)
          )
        );
      }
    }
    let serializedKey =
      key instanceof SymbolValue
        ? this.serializeValue(key)
        : this.generator.getAsPropertyNameExpression(key, /*canBeIdentifier*/ false);
    invariant(!this.emitter.getReasonToWaitForDependencies([val]), "precondition of _emitProperty");
    body.push(
      t.callExpression(this.preludeGenerator.memoizeReference("Object.defineProperty"), [
        this.getSerializeObjectIdentifier(val),
        serializedKey,
        descriptorId,
      ])
    );
    return t.expressionStatement(t.sequenceExpression(body));
  }

  _serializeDeclarativeEnvironmentRecordBinding(
    residualFunctionBinding: ResidualFunctionBinding,
    name: string,
    instance: FunctionInstance
  ) {
    if (!residualFunctionBinding.serializedValue) {
      let value = residualFunctionBinding.value;
      invariant(value);
      invariant(residualFunctionBinding.declarativeEnvironmentRecord);

      // Set up binding identity before starting to serialize value. This is needed in case of recursive dependencies.
      residualFunctionBinding.serializedValue = this.serializeValue(value);
      if (residualFunctionBinding.modified)
        this.referentializer.referentializeBinding(residualFunctionBinding, name, instance);
      if (value.mightBeObject()) {
        // Increment ref count one more time to ensure that this object will be assigned a unique id.
        // This ensures that only once instance is created across all possible residual function invocations.
        this.residualHeapValueIdentifiers.incrementReferenceCount(value);
      }
    }
  }

  // Augments an initial set of generators with all generators from
  // which any of a given set of function values is referenced.
  _getReferencingGenerators(
    initialGenerators: Array<Generator>,
    functionValues: Array<FunctionValue>
  ): Array<Generator> {
    let result = new Set(initialGenerators);
    let activeFunctions = functionValues.slice();
    let visitedFunctions = new Set();
    while (activeFunctions.length > 0) {
      let last = activeFunctions.pop();
      let scopes = this.residualValues.get(last);
      invariant(scopes);
      for (let scope of scopes)
        if (scope instanceof FunctionValue) {
          if (!visitedFunctions.has(scope)) {
            visitedFunctions.add(scope);
            activeFunctions.push(scope);
          }
        } else {
          invariant(scope instanceof Generator);
          result.add(scope);
        }
    }
    return Array.from(result);
  }

  // Determine if a value is effectively referenced by a single additional function.
  isReferencedOnlyByAdditionalFunction(val: Value): void | FunctionValue {
    let scopes = this.residualValues.get(val);
    invariant(scopes !== undefined);
    let additionalFunction;
    for (let scope of scopes)
      if (scope instanceof Generator) {
        let f;
        for (let g = scope; g !== undefined && f === undefined; g = this.getGeneratorParent(g))
          f = this.additionalFunctionGeneratorsInverse.get(g);
        if (f === undefined) return undefined;
        if (additionalFunction !== undefined && additionalFunction !== f) return undefined;
        additionalFunction = f;
      } else {
        invariant(scope instanceof FunctionValue);
        if (this.additionalFunctionGenerators.has(scope)) {
          if (additionalFunction !== undefined && additionalFunction !== scope) return undefined;
          additionalFunction = scope;
        } else {
          let f = this.isReferencedOnlyByAdditionalFunction(scope);
          if (f === undefined) return undefined;
          if (additionalFunction !== undefined && additionalFunction !== f) return undefined;
          additionalFunction = f;
        }
      }
    return additionalFunction;
  }

  // Determine whether initialization code for a value should go into the main body, or a more specific initialization body.
  _getTarget(
    val: Value
  ): {
    body: SerializedBody,
    usedOnlyByResidualFunctions?: true,
    usedOnlyByAdditionalFunctions?: boolean,
    commonAncestor?: Scope,
    description?: string,
  } {
    let scopes = this.residualValues.get(val);
    invariant(scopes !== undefined);

    // All relevant values were visited in at least one scope.
    invariant(scopes.size >= 1);

    // First, let's figure out from which function and generator scopes this value is referenced.
    let functionValues = [];
    let generators = [];
    for (let scope of scopes) {
      if (scope instanceof FunctionValue) {
        functionValues.push(scope);
      } else {
        invariant(scope instanceof Generator);
        generators.push(scope);
      }
    }

    let additionalFunctionValue = this.isReferencedOnlyByAdditionalFunction(val);
    if (generators.length === 0) {
      // This value is only referenced from residual functions.
      if (
        additionalFunctionValue === undefined &&
        this._options.delayInitializations &&
        !this._options.simpleClosures
      ) {
        // We can delay the initialization, and move it into a conditional code block in the residual functions!
        let body = this.residualFunctions.residualFunctionInitializers.registerValueOnlyReferencedByResidualFunctions(
          functionValues,
          val
        );

        return { body, usedOnlyByResidualFunctions: true, description: "delay_initializer" };
      }
    }

    if (additionalFunctionValue !== undefined) {
      let additionalFunctionGenerator = this.additionalFunctionGenerators.get(additionalFunctionValue);
      invariant(additionalFunctionGenerator !== undefined);
      let body = this.activeGeneratorBodies.get(additionalFunctionGenerator);
      invariant(body !== undefined);
      return { body, usedOnlyByAdditionalFunctions: true };
    }

    let getBody = s => {
      if (s === this.generator) {
        return this.mainBody;
      } else {
        return this.activeGeneratorBodies.get(s);
      }
    };

    // flatten all function values into the scopes that use them
    generators = this._getReferencingGenerators(generators, functionValues);

    // Remove all generators rooted in additional functions,
    // since we know that there's at least one root that's not in an additional function
    // which requires the value to be emitted outside of the additional function.
    generators = generators.filter(generator => {
      for (let g = generator; g !== undefined; g = this.getGeneratorParent(g))
        if (this.additionalFunctionGeneratorsInverse.has(g)) return false;
      return true;
    });
    invariant(generators.length > 0);

    // This value is referenced from more than one generator or function.
    // Let's find the body associated with their common ancestor.
    let commonAncestor = Array.from(generators).reduce(
      (x, y) => commonAncestorOf(x, y, this.getGeneratorParent),
      generators[0]
    );
    invariant(commonAncestor);

    let body;
    while (true) {
      body = getBody(commonAncestor);
      if (body !== undefined) break;
      commonAncestor = this.getGeneratorParent(commonAncestor);
      invariant(commonAncestor !== undefined);
    }

    // So we have a (common ancestor) body now.
    invariant(body !== undefined);

    // However, there's a potential problem: That body might belong to a generator
    // which has nested generators that are currently being processed (they are not "done" yet).
    // This becomes a problem when the value for which we are trying to determine the target body
    // depends on other values which are only declared in such not-yet-done nested generator!
    // So we find all such not-yet-done bodies here, and pick a most nested one
    // which is related to one of the scopes this value is used by.
    let notYetDoneBodies = new Set();
    this.emitter.dependenciesVisitor(val, {
      onAbstractValueWithIdentifier: dependency => {
        let declarationBody = this.emitter.getDeclarationBody(dependency);
        if (declarationBody !== undefined)
          for (let b = declarationBody; b !== undefined; b = b.parentBody) {
            if (notYetDoneBodies.has(b)) break;
            notYetDoneBodies.add(b);
          }
      },
    });
    for (let s of generators)
      for (let g = s; g !== undefined; g = this.getGeneratorParent(g)) {
        let scopeBody = getBody(g);
        if (
          scopeBody !== undefined &&
          (scopeBody.nestingLevel || 0) > (body.nestingLevel || 0) &&
          notYetDoneBodies.has(scopeBody)
        ) {
          // TODO: If there are multiple such scopeBody's, why is it okay to pick an arbitrary one?
          body = scopeBody;
          break;
        }
      }

    return { body, commonAncestor };
  }

  _getValueDebugName(val: Value) {
    let name;
    if (val instanceof FunctionValue) {
      name = val.getName();
    } else {
      const id = this.residualHeapValueIdentifiers.getIdentifier(val);
      invariant(id);
      name = id.name;
    }
    return name;
  }

  serializeBinding(binding: Binding): BabelNodeIdentifier | BabelNodeMemberExpression {
    let record = binding.environment;
    invariant(record instanceof DeclarativeEnvironmentRecord, "only declarative environments has bindings");

    let residualFunctionBindings = this.declarativeEnvironmentRecordsBindings.get(record);
    invariant(
      residualFunctionBindings,
      "all bindings that create abstract values must have at least one call emitted to the generator so the function environment should have been visited"
    );
    let residualBinding = residualFunctionBindings.get(binding.name);
    invariant(residualBinding, "any referenced residual binding should have been visited");

    if (!residualBinding.referentialized) {
      let additionalFunction = residualBinding.referencedOnlyFromAdditionalFunctions;
      invariant(additionalFunction, "residual bindings like this are only caused by leaked bindings in pure functions");
      let instance = this.residualFunctionInstances.get(additionalFunction);
      invariant(instance, "any serialized function must exist in the scope");
      this.residualFunctions.referentializer.referentializeBinding(residualBinding, binding.name, instance);
    }

    invariant(residualBinding.serializedValue);
    return ((residualBinding.serializedValue: any): BabelNodeIdentifier | BabelNodeMemberExpression);
  }

  _declare(
    emittingToResidualFunction: boolean,
    bindingType: BabelVariableKind,
    id: BabelNodeLVal,
    init: BabelNodeExpression
  ) {
    if (emittingToResidualFunction) {
      let declar = t.variableDeclaration(bindingType, [t.variableDeclarator(id)]);
      this.mainBody.entries.push(declar);
      let assignment = t.expressionStatement(t.assignmentExpression("=", id, init));
      this.emitter.emit(assignment);
    } else {
      let declar = t.variableDeclaration(bindingType, [t.variableDeclarator(id, init)]);
      this.emitter.emit(declar);
    }
  }

  serializeValue(val: Value, referenceOnly?: boolean, bindingType?: BabelVariableKind): BabelNodeExpression {
    invariant(!val.refuseSerialization);
    if (val instanceof AbstractValue) {
      if (val.kind === "widened") {
        this.serializedValues.add(val);
        let name = val.intrinsicName;
        invariant(name !== undefined);
        return t.identifier(name);
      } else if (val.kind === "widened property") {
        this.serializedValues.add(val);
        return this._serializeAbstractValueHelper(val);
      }
    }

    // make sure we're not serializing a class method here
    if (val instanceof ECMAScriptSourceFunctionValue && this.residualClassMethodInstances.has(val)) {
      let classMethodInstance = this.residualClassMethodInstances.get(val);
      invariant(classMethodInstance);
      // anything other than a class constructor should never go through serializeValue()
      // so we need to log a nice error message to the user
      if (classMethodInstance.methodType !== "constructor") {
        let error = new CompilerDiagnostic(
          "a class method incorrectly went through the serializeValue() code path",
          val.$ECMAScriptCode.loc,
          "PP0022",
          "FatalError"
        );
        this.realm.handleError(error);
        throw new FatalError();
      }
    }

    if (this._serializedValueWithIdentifiers.has(val)) {
      return this.getSerializeObjectIdentifier(val);
    }

    this.serializedValues.add(val);
    if (!referenceOnly && ResidualHeapInspector.isLeaf(val)) {
      let res = this._serializeValue(val);
      invariant(res !== undefined);
      return res;
    }
    this._serializedValueWithIdentifiers.add(val);

    let target = this._getTarget(val);
    let oldBody = this.emitter.beginEmitting(val, target.body);
    let init = this._serializeValue(val);

    let id = this.residualHeapValueIdentifiers.getIdentifier(val);
    let result = id;
    this.residualHeapValueIdentifiers.incrementReferenceCount(val);

    if (this.residualHeapValueIdentifiers.needsIdentifier(val)) {
      if (init) {
        if (this._options.debugScopes) {
          let scopes = this.residualValues.get(val);
          invariant(scopes !== undefined);
          const scopeList = Array.from(scopes).map(s => `"${s.getName()}"`).join(",");
          let comment = `${this._getValueDebugName(val)} referenced from scopes [${scopeList}]`;
          if (target.commonAncestor !== undefined)
            comment = `${comment} with common ancestor: ${target.commonAncestor.getName()}`;
          if (target.description !== undefined) comment = `${comment} => ${target.description} `;
          this.emitter.emit(commentStatement(comment));
        }
        if (init !== id) {
          this._declare(!!target.usedOnlyByResidualFunctions, bindingType || "var", id, init);
        }
        this.statistics.valueIds++;
        if (target.usedOnlyByResidualFunctions) this.statistics.delayedValues++;
      }
    } else {
      if (init) {
        this.residualHeapValueIdentifiers.deleteIdentifier(val);
        result = init;
        this.statistics.valuesInlined++;
      }
    }

    this.emitter.endEmitting(val, oldBody);
    return result;
  }

  _serializeValueIntrinsic(val: Value): BabelNodeExpression {
    let intrinsicName = val.intrinsicName;
    invariant(intrinsicName);
    if (val instanceof ObjectValue && val.intrinsicNameGenerated) {
      // The intrinsic was generated at a particular point in time.
      return this.preludeGenerator.convertStringToMember(intrinsicName);
    } else {
      // The intrinsic conceptually exists ahead of time.
      invariant(
        this.emitter.getBody().type === "MainGenerator" ||
          this.emitter.getBody().type === "AdditionalFunction" ||
          this.emitter.getBody().type === "DelayInitializations"
      );
      return this.preludeGenerator.memoizeReference(intrinsicName);
    }
  }

  _getDescriptorValues(desc: Descriptor): Array<Value> {
    if (desc.joinCondition !== undefined) return [desc.joinCondition];
    invariant(desc.value === undefined || desc.value instanceof Value);
    if (desc.value !== undefined) return [desc.value];
    invariant(desc.get !== undefined);
    invariant(desc.set !== undefined);
    return [desc.get, desc.set];
  }

  _deleteProperty(location: BabelNodeLVal) {
    invariant(location.type === "MemberExpression");
    this.emitter.emit(
      t.expressionStatement(t.unaryExpression("delete", ((location: any): BabelNodeMemberExpression), true))
    );
  }

  _assignProperty(
    locationFn: () => BabelNodeLVal,
    valueFn: () => BabelNodeExpression,
    mightHaveBeenDeleted: boolean,
    deleteIfMightHaveBeenDeleted: boolean = false
  ) {
    this.emitter.emit(
      this._getPropertyAssignment(locationFn, valueFn, mightHaveBeenDeleted, deleteIfMightHaveBeenDeleted)
    );
  }

  _getPropertyAssignment(
    locationFn: () => BabelNodeLVal,
    valueFn: () => BabelNodeExpression,
    mightHaveBeenDeleted: boolean,
    deleteIfMightHaveBeenDeleted: boolean = false
  ) {
    let location = locationFn();
    let value = valueFn();
    let assignment = t.expressionStatement(t.assignmentExpression("=", location, value));
    if (mightHaveBeenDeleted) {
      let condition = t.binaryExpression("!==", value, this.serializeValue(this.realm.intrinsics.empty));
      let deletion = null;
      if (deleteIfMightHaveBeenDeleted) {
        invariant(location.type === "MemberExpression");
        deletion = t.expressionStatement(
          t.unaryExpression("delete", ((location: any): BabelNodeMemberExpression), true)
        );
      }
      return t.ifStatement(condition, assignment, deletion);
    } else {
      return assignment;
    }
  }

  _serializeArrayIndexProperties(
    array: ObjectValue,
    indexPropertyLength: number,
    remainingProperties: Map<string, PropertyBinding>
  ) {
    let elems = [];
    for (let i = 0; i < indexPropertyLength; i++) {
      let key = i + "";
      let propertyBinding = remainingProperties.get(key);
      let elem = null;
      // "propertyBinding === undefined" means array has a hole in the middle.
      if (propertyBinding !== undefined) {
        let descriptor = propertyBinding.descriptor;
        // "descriptor === undefined" means this array item has been deleted.
        if (
          descriptor !== undefined &&
          descriptor.value !== undefined &&
          this._canEmbedProperty(array, key, descriptor)
        ) {
          let elemVal = descriptor.value;
          invariant(elemVal instanceof Value);
          let mightHaveBeenDeleted = elemVal.mightHaveBeenDeleted();
          let delayReason =
            this.emitter.getReasonToWaitForDependencies(elemVal) ||
            this.emitter.getReasonToWaitForActiveValue(array, mightHaveBeenDeleted);
          if (!delayReason) {
            elem = this.serializeValue(elemVal);
            remainingProperties.delete(key);
          }
        }
      }
      elems.push(elem);
    }
    return elems;
  }

  _serializeArrayLengthIfNeeded(
    val: ObjectValue,
    numberOfIndexProperties: number,
    remainingProperties: Map<string, PropertyBinding>
  ): void {
    const realm = this.realm;
    let lenProperty;
    if (val.isLeakedObject()) {
      lenProperty = this.realm.evaluateWithoutLeakLogic(() => Get(realm, val, "length"));
    } else {
      lenProperty = Get(realm, val, "length");
    }
    // Need to serialize length property if:
    // 1. array length is abstract.
    // 2. array length is concrete, but different from number of index properties
    //  we put into initialization list.
    if (lenProperty instanceof AbstractValue || To.ToLength(realm, lenProperty) !== numberOfIndexProperties) {
      if (!(lenProperty instanceof AbstractValue) || lenProperty.kind !== "widened property") {
        this.emitter.emitNowOrAfterWaitingForDependencies([val], () => {
          this._assignProperty(
            () => t.memberExpression(this.getSerializeObjectIdentifier(val), t.identifier("length")),
            () => {
              return this.serializeValue(lenProperty);
            },
            false /*mightHaveBeenDeleted*/
          );
        });
      }
      remainingProperties.delete("length");
    }
  }

  _serializeValueArray(val: ObjectValue): BabelNodeExpression {
    let remainingProperties = new Map(val.properties);

    const indexPropertyLength = getSuggestedArrayLiteralLength(this.realm, val);
    // Use the serialized index properties as array initialization list.
    const initProperties = this._serializeArrayIndexProperties(val, indexPropertyLength, remainingProperties);
    this._serializeArrayLengthIfNeeded(val, indexPropertyLength, remainingProperties);
    this._emitObjectProperties(val, remainingProperties);
    return t.arrayExpression(initProperties);
  }

  _serializeValueMap(val: ObjectValue): BabelNodeExpression {
    let kind = val.getKind();
    let elems = [];

    let entries;
    if (kind === "Map") {
      entries = val.$MapData;
    } else {
      invariant(kind === "WeakMap");
      entries = val.$WeakMapData;
    }
    invariant(entries !== undefined);
    let len = entries.length;
    let mapConstructorDoesntTakeArguments = this.realm.isCompatibleWith(this.realm.MOBILE_JSC_VERSION);

    for (let i = 0; i < len; i++) {
      let entry = entries[i];
      let key = entry.$Key;
      let value = entry.$Value;
      if (key === undefined || value === undefined) continue;
      let mightHaveBeenDeleted = key.mightHaveBeenDeleted();
      let delayReason =
        this.emitter.getReasonToWaitForDependencies(key) ||
        this.emitter.getReasonToWaitForDependencies(value) ||
        this.emitter.getReasonToWaitForActiveValue(val, mightHaveBeenDeleted || mapConstructorDoesntTakeArguments);
      if (delayReason) {
        this.emitter.emitAfterWaiting(delayReason, [key, value, val], () => {
          invariant(key !== undefined);
          invariant(value !== undefined);
          this.emitter.emit(
            t.expressionStatement(
              t.callExpression(
                t.memberExpression(
                  this.residualHeapValueIdentifiers.getIdentifierAndIncrementReferenceCount(val),
                  t.identifier("set")
                ),
                [this.serializeValue(key), this.serializeValue(value)]
              )
            )
          );
        });
      } else {
        let serializedKey = this.serializeValue(key);
        let serializedValue = this.serializeValue(value);
        let elem = t.arrayExpression([serializedKey, serializedValue]);
        elems.push(elem);
      }
    }

    this._emitObjectProperties(val);
    let args = elems.length > 0 ? [t.arrayExpression(elems)] : [];
    return t.newExpression(this.preludeGenerator.memoizeReference(kind), args);
  }

  _serializeValueSet(val: ObjectValue): BabelNodeExpression {
    let kind = val.getKind();
    let elems = [];

    let entries;
    if (kind === "Set") {
      entries = val.$SetData;
    } else {
      invariant(kind === "WeakSet");
      entries = val.$WeakSetData;
    }
    invariant(entries !== undefined);
    let len = entries.length;
    let setConstructorDoesntTakeArguments = this.realm.isCompatibleWith(this.realm.MOBILE_JSC_VERSION);

    for (let i = 0; i < len; i++) {
      let entry = entries[i];
      if (entry === undefined) continue;
      let mightHaveBeenDeleted = entry.mightHaveBeenDeleted();
      let delayReason =
        this.emitter.getReasonToWaitForDependencies(entry) ||
        this.emitter.getReasonToWaitForActiveValue(val, mightHaveBeenDeleted || setConstructorDoesntTakeArguments);
      if (delayReason) {
        this.emitter.emitAfterWaiting(delayReason, [entry, val], () => {
          invariant(entry !== undefined);
          this.emitter.emit(
            t.expressionStatement(
              t.callExpression(
                t.memberExpression(
                  this.residualHeapValueIdentifiers.getIdentifierAndIncrementReferenceCount(val),
                  t.identifier("add")
                ),
                [this.serializeValue(entry)]
              )
            )
          );
        });
      } else {
        let elem = this.serializeValue(entry);
        elems.push(elem);
      }
    }

    this._emitObjectProperties(val);
    let args = elems.length > 0 ? [t.arrayExpression(elems)] : [];
    return t.newExpression(this.preludeGenerator.memoizeReference(kind), args);
  }

  _serializeValueTypedArrayOrDataView(val: ObjectValue): BabelNodeExpression {
    let buf = val.$ViewedArrayBuffer;
    invariant(buf !== undefined);
    let outlinedArrayBuffer = this.serializeValue(buf, true);
    this._emitObjectProperties(val);
    return t.newExpression(this.preludeGenerator.memoizeReference(val.getKind()), [outlinedArrayBuffer]);
  }

  _serializeValueArrayBuffer(val: ObjectValue): BabelNodeExpression {
    let elems = [];

    let len = val.$ArrayBufferByteLength;
    let db = val.$ArrayBufferData;
    invariant(len !== undefined);
    invariant(db);
    let allzero = true;
    for (let i = 0; i < len; i++) {
      if (db[i] !== 0) {
        allzero = false;
      }
      let elem = t.numericLiteral(db[i]);
      elems.push(elem);
    }

    this._emitObjectProperties(val);
    if (allzero) {
      // if they're all zero, just emit the array buffer constructor
      return t.newExpression(this.preludeGenerator.memoizeReference(val.getKind()), [t.numericLiteral(len)]);
    } else {
      // initialize from a byte array otherwise
      let arrayValue = t.arrayExpression(elems);
      let consExpr = t.newExpression(this.preludeGenerator.memoizeReference("Uint8Array"), [arrayValue]);
      // access the Uint8Array.buffer property to extract the created buffer
      return t.memberExpression(consExpr, t.identifier("buffer"));
    }
  }

  _serializeValueFunction(val: FunctionValue): void | BabelNodeExpression {
    if (val instanceof BoundFunctionValue) {
      this._emitObjectProperties(val);
      return t.callExpression(
        t.memberExpression(this.serializeValue(val.$BoundTargetFunction), t.identifier("bind")),
        [].concat(
          this.serializeValue(val.$BoundThis),
          val.$BoundArguments.map((boundArg, i) => this.serializeValue(boundArg))
        )
      );
    }

    invariant(!(val instanceof NativeFunctionValue), "all native function values should be intrinsics");
    invariant(val instanceof ECMAScriptSourceFunctionValue);

    let instance = this.residualFunctionInstances.get(val);
    invariant(instance !== undefined);
    let residualBindings = instance.residualFunctionBindings;

    let inAdditionalFunction = this.isReferencedOnlyByAdditionalFunction(val);
    if (inAdditionalFunction !== undefined) instance.containingAdditionalFunction = inAdditionalFunction;
    let delayed = 1;
    let undelay = () => {
      if (--delayed === 0) {
        invariant(instance);
        // hoist if we are in an additionalFunction
        if (inAdditionalFunction !== undefined && canHoistFunction(this.realm, val, undefined, new Set())) {
          instance.insertionPoint = new BodyReference(this.mainBody, this.mainBody.entries.length);
          instance.containingAdditionalFunction = undefined;
        } else {
          instance.insertionPoint = this.emitter.getBodyReference();
        }
      }
    };
    for (let [boundName, residualBinding] of residualBindings) {
      let referencedValues = [];
      let serializeBindingFunc;
      if (!residualBinding.declarativeEnvironmentRecord) {
        serializeBindingFunc = () => this._serializeGlobalBinding(boundName, residualBinding);
      } else {
        serializeBindingFunc = () => {
          invariant(instance !== undefined);
          return this._serializeDeclarativeEnvironmentRecordBinding(residualBinding, boundName, instance);
        };
        let bindingValue = residualBinding.value;
        invariant(bindingValue !== undefined);
        referencedValues.push(bindingValue);
        if (inAdditionalFunction !== undefined) {
          let bindingAdditionalFunction = this.isReferencedOnlyByAdditionalFunction(bindingValue);
          if (bindingAdditionalFunction !== undefined)
            residualBinding.referencedOnlyFromAdditionalFunctions = bindingAdditionalFunction;
        }
      }
      delayed++;
      this.emitter.emitNowOrAfterWaitingForDependencies(referencedValues, () => {
        serializeBindingFunc();
        undelay();
      });
    }
    if (val.$FunctionKind === "classConstructor") {
      let homeObject = val.$HomeObject;
      if (homeObject instanceof ObjectValue && homeObject.$IsClassPrototype) {
        this._serializeClass(val, homeObject, undelay);
        return;
      }
    }
    undelay();
    this._emitObjectProperties(val);
  }

  _serializeClass(classFunc: ECMAScriptSourceFunctionValue, classPrototype: ObjectValue, undelay: Function): void {
    let classMethodInstance = this.residualClassMethodInstances.get(classFunc);

    invariant(classMethodInstance !== undefined);

    let classProtoId;
    let hasSerializedClassProtoId = false;
    let propertiesToSerialize = new Map();

    // handle class inheritance
    if (!(classFunc.$Prototype instanceof NativeFunctionValue)) {
      classMethodInstance.classSuperNode = this.serializeValue(classFunc.$Prototype);
    }

    let serializeClassPrototypeId = () => {
      if (!hasSerializedClassProtoId) {
        let classId = this.getSerializeObjectIdentifier(classFunc);
        classProtoId = t.identifier(this.intrinsicNameGenerator.generate());
        hasSerializedClassProtoId = true;
        this.emitter.emit(
          t.variableDeclaration("var", [
            t.variableDeclarator(classProtoId, t.memberExpression(classId, t.identifier("prototype"))),
          ])
        );
      }
    };

    let serializeClassMethod = (propertyNameOrSymbol, methodFunc) => {
      invariant(methodFunc instanceof ECMAScriptSourceFunctionValue);
      if (methodFunc !== classFunc) {
        // if the method does not have a $HomeObject, it's not a class method
        if (methodFunc.$HomeObject !== undefined) {
          this.serializedValues.add(methodFunc);
          this._serializeClassMethod(propertyNameOrSymbol, methodFunc);
        } else {
          // if the method is not part of the class, we have to assign it to the prototype
          // we can't serialize via emitting the properties as that will emit all
          // the prototype and we only want to mutate the prototype here
          serializeClassPrototypeId();
          let methodId = this.serializeValue(methodFunc);
          let name;

          if (typeof propertyNameOrSymbol === "string") {
            name = t.identifier(propertyNameOrSymbol);
          } else {
            name = this.serializeValue(propertyNameOrSymbol);
          }
          invariant(classProtoId !== undefined);
          this.emitter.emit(
            t.expressionStatement(t.assignmentExpression("=", t.memberExpression(classProtoId, name), methodId))
          );
        }
      }
    };

    let serializeClassProperty = (propertyNameOrSymbol, propertyValue) => {
      // we handle the prototype via class syntax
      if (propertyNameOrSymbol === "prototype") {
        this.serializedValues.add(propertyValue);
      } else if (propertyValue instanceof ECMAScriptSourceFunctionValue && propertyValue.$HomeObject === classFunc) {
        serializeClassMethod(propertyNameOrSymbol, propertyValue);
      } else {
        let prop = classFunc.properties.get(propertyNameOrSymbol);
        invariant(prop);
        propertiesToSerialize.set(propertyNameOrSymbol, prop);
      }
    };

    // find the all the properties on the class that we need to serialize
    for (let [propertyName, method] of classFunc.properties) {
      if (
        !this.residualHeapInspector.canIgnoreProperty(classFunc, propertyName) &&
        !ClassPropertiesToIgnore.has(propertyName) &&
        method.descriptor !== undefined &&
        !(propertyName === "length" && canIgnoreClassLengthProperty(classFunc, method.descriptor, this.logger))
      ) {
        withDescriptorValue(propertyName, method.descriptor, serializeClassProperty);
      }
    }
    // pass in the properties and set it so we don't serialize the prototype
    undelay();
    this._emitObjectProperties(classFunc, propertiesToSerialize, undefined, undefined, true);

    // handle non-symbol properties
    for (let [propertyName, method] of classPrototype.properties) {
      withDescriptorValue(propertyName, method.descriptor, serializeClassMethod);
    }
    // handle symbol properties
    for (let [symbol, method] of classPrototype.symbols) {
      withDescriptorValue(symbol, method.descriptor, serializeClassMethod);
    }
    // assign the AST method key node for the "constructor"
    classMethodInstance.classMethodKeyNode = t.identifier("constructor");
  }

  _serializeClassMethod(key: string | SymbolValue, methodFunc: ECMAScriptSourceFunctionValue): void {
    let classMethodInstance = this.residualClassMethodInstances.get(methodFunc);

    invariant(classMethodInstance !== undefined);
    if (typeof key === "string") {
      classMethodInstance.classMethodKeyNode = t.identifier(key);
      // as we know the method name is a string again, we can remove the computed status
      classMethodInstance.classMethodComputed = false;
    } else if (key instanceof SymbolValue) {
      classMethodInstance.classMethodKeyNode = this.serializeValue(key);
    } else {
      invariant(false, "Unknown method key type");
    }
    this._serializeValueFunction(methodFunc);
  }

  // Checks whether a property can be defined via simple assignment, or using object literal syntax.
  _canEmbedProperty(obj: ObjectValue, key: string | SymbolValue, prop: Descriptor): boolean {
    if (prop.joinCondition !== undefined) return false;

    let targetDescriptor = this.residualHeapInspector.getTargetIntegrityDescriptor(obj);

    if ((obj instanceof FunctionValue && key === "prototype") || (obj.getKind() === "RegExp" && key === "lastIndex"))
      return (
        prop.writable === targetDescriptor.writable && !prop.configurable && !prop.enumerable && !prop.set && !prop.get
      );
    else if (
      prop.writable === targetDescriptor.writable &&
      prop.configurable === targetDescriptor.configurable &&
      !!prop.enumerable &&
      !prop.set &&
      !prop.get
    ) {
      return !(prop.value instanceof AbstractValue && prop.value.kind === "widened property");
    } else {
      return false;
    }
  }

  _findLastObjectPrototype(obj: ObjectValue): ObjectValue {
    while (obj.$Prototype instanceof ObjectValue) obj = obj.$Prototype;
    return obj;
  }

  _serializeValueRegExpObject(val: ObjectValue): BabelNodeExpression {
    let source = val.$OriginalSource;
    let flags = val.$OriginalFlags;
    invariant(typeof source === "string");
    invariant(typeof flags === "string");
    this._emitObjectProperties(val);
    source = new RegExp(source).source; // add escapes as per 21.2.3.2.4
    return t.regExpLiteral(source, flags);
  }

  // Overridable.
  serializeValueRawObject(val: ObjectValue, skipPrototype: boolean): BabelNodeExpression {
    let remainingProperties = new Map(val.properties);
    const dummyProperties = new Set();
    let props = [];
    for (let [key, propertyBinding] of val.properties) {
      if (propertyBinding.pathNode !== undefined) continue; // written to inside loop
      let descriptor = propertyBinding.descriptor;
      if (descriptor === undefined || descriptor.value === undefined) continue; // deleted
      if (this._canEmbedProperty(val, key, descriptor)) {
        let propValue = descriptor.value;
        invariant(propValue instanceof Value);
        if (this.residualHeapInspector.canIgnoreProperty(val, key)) continue;
        let mightHaveBeenDeleted = propValue.mightHaveBeenDeleted();
        let serializedKey = this.generator.getAsPropertyNameExpression(key);
        let delayReason =
          this.emitter.getReasonToWaitForDependencies(propValue) ||
          this.emitter.getReasonToWaitForActiveValue(val, mightHaveBeenDeleted);
        // Although the property needs to be delayed, we still want to emit dummy "undefined"
        // value as part of the object literal to ensure a consistent property ordering.
        let serializedValue = voidExpression;
        if (delayReason) {
          // May need to be cleaned up later.
          dummyProperties.add(key);
        } else {
          remainingProperties.delete(key);
          serializedValue = this.serializeValue(propValue);
        }
        props.push(t.objectProperty(serializedKey, serializedValue));
      } else if (descriptor.value instanceof Value && descriptor.value.mightHaveBeenDeleted()) {
        dummyProperties.add(key);
        let serializedKey = this.generator.getAsPropertyNameExpression(key);
        props.push(t.objectProperty(serializedKey, voidExpression));
      }
    }
    this._emitObjectProperties(
      val,
      remainingProperties,
      /*objectPrototypeAlreadyEstablished*/ false,
      dummyProperties,
      skipPrototype
    );
    return t.objectExpression(props);
  }

  _serializeValueObjectViaConstructor(val: ObjectValue, skipPrototype: boolean, classConstructor?: Value) {
    let proto = val.$Prototype;
    this._emitObjectProperties(
      val,
      val.properties,
      /*objectPrototypeAlreadyEstablished*/ true,
      undefined,
      skipPrototype
    );
    this.needsAuxiliaryConstructor = true;
    let serializedProto = this.serializeValue(classConstructor ? classConstructor : proto);
    return t.sequenceExpression([
      t.assignmentExpression(
        "=",
        t.memberExpression(constructorExpression, t.identifier("prototype")),
        classConstructor ? t.memberExpression(serializedProto, t.identifier("prototype")) : serializedProto
      ),
      t.newExpression(constructorExpression, []),
    ]);
  }

  serializeValueObject(val: ObjectValue): BabelNodeExpression | void {
    // If this object is a prototype object that was implicitly created by the runtime
    // for a constructor, then we can obtain a reference to this object
    // in a special way that's handled alongside function serialization.
    let constructor = val.originalConstructor;
    if (constructor !== undefined) {
      let prototypeId = this.residualHeapValueIdentifiers.getIdentifier(val);
      this.emitter.emitNowOrAfterWaitingForDependencies([constructor], () => {
        invariant(constructor !== undefined);
        invariant(prototypeId !== undefined);
        this.serializeValue(constructor);
        this._emitObjectProperties(val);
        invariant(prototypeId.type === "Identifier");
        this.residualFunctions.setFunctionPrototype(constructor, prototypeId);
      });
      return prototypeId;
    }

    let kind = val.getKind();
    switch (kind) {
      case "RegExp":
        return this._serializeValueRegExpObject(val);
      case "Number":
        let numberData = val.$NumberData;
        invariant(numberData !== undefined);
        numberData.throwIfNotConcreteNumber();
        invariant(numberData instanceof NumberValue, "expected number data internal slot to be a number value");
        this._emitObjectProperties(val);
        return t.newExpression(this.preludeGenerator.memoizeReference("Number"), [t.numericLiteral(numberData.value)]);
      case "String":
        let stringData = val.$StringData;
        invariant(stringData !== undefined);
        stringData.throwIfNotConcreteString();
        invariant(stringData instanceof StringValue, "expected string data internal slot to be a string value");
        this._emitObjectProperties(val);
        return t.newExpression(this.preludeGenerator.memoizeReference("String"), [t.stringLiteral(stringData.value)]);
      case "Boolean":
        let booleanData = val.$BooleanData;
        invariant(booleanData !== undefined);
        booleanData.throwIfNotConcreteBoolean();
        invariant(booleanData instanceof BooleanValue, "expected boolean data internal slot to be a boolean value");
        this._emitObjectProperties(val);
        return t.newExpression(this.preludeGenerator.memoizeReference("Boolean"), [
          t.booleanLiteral(booleanData.value),
        ]);
      case "Date":
        let dateValue = val.$DateValue;
        invariant(dateValue !== undefined);
        let serializedDateValue = this.serializeValue(dateValue);
        this._emitObjectProperties(val);
        return t.newExpression(this.preludeGenerator.memoizeReference("Date"), [serializedDateValue]);
      case "Float32Array":
      case "Float64Array":
      case "Int8Array":
      case "Int16Array":
      case "Int32Array":
      case "Uint8Array":
      case "Uint16Array":
      case "Uint32Array":
      case "Uint8ClampedArray":
      case "DataView":
        return this._serializeValueTypedArrayOrDataView(val);
      case "ArrayBuffer":
        return this._serializeValueArrayBuffer(val);
      case "ReactElement":
        this.residualReactElementSerializer.serializeReactElement(val);
        return;
      case "Map":
      case "WeakMap":
        return this._serializeValueMap(val);
      case "Set":
      case "WeakSet":
        return this._serializeValueSet(val);
      default:
        invariant(kind === "Object", "invariant established by visitor");
        invariant(this.$ParameterMap === undefined, "invariant established by visitor");

        let proto = val.$Prototype;
        let createViaAuxiliaryConstructor =
          proto !== this.realm.intrinsics.ObjectPrototype &&
          this._findLastObjectPrototype(val) === this.realm.intrinsics.ObjectPrototype &&
          proto instanceof ObjectValue;
        let { skipPrototype, constructor: _constructor } = getObjectPrototypeMetadata(this.realm, val);

        return createViaAuxiliaryConstructor
          ? this._serializeValueObjectViaConstructor(val, skipPrototype, _constructor)
          : this.serializeValueRawObject(val, skipPrototype);
    }
  }

  _serializeValueSymbol(val: SymbolValue): BabelNodeExpression {
    let args = [];
    if (val.$Description instanceof Value) {
      let serializedArg = this.serializeValue(val.$Description);
      invariant(serializedArg);
      args.push(serializedArg);
    }
    // check if symbol value exists in the global symbol map, in that case we emit an invocation of System.for
    // to look it up
    let globalReg = this.realm.globalSymbolRegistry.find(e => e.$Symbol === val) !== undefined;
    if (globalReg) {
      return t.callExpression(this.preludeGenerator.memoizeReference("Symbol.for"), args);
    } else {
      return t.callExpression(this.preludeGenerator.memoizeReference("Symbol"), args);
    }
  }

  _serializeValueProxy(val: ProxyValue): BabelNodeExpression {
    return t.newExpression(this.preludeGenerator.memoizeReference("Proxy"), [
      this.serializeValue(val.$ProxyTarget),
      this.serializeValue(val.$ProxyHandler),
    ]);
  }

  _serializeAbstractValueHelper(val: AbstractValue): BabelNodeExpression {
    let serializedArgs = val.args.map((abstractArg, i) => this.serializeValue(abstractArg));
    if (val.kind === "abstractConcreteUnion") {
      let abstractIndex = val.args.findIndex(v => v instanceof AbstractValue);
      invariant(abstractIndex >= 0 && abstractIndex < val.args.length);
      return serializedArgs[abstractIndex];
    }
    let serializedValue = val.buildNode(serializedArgs);
    if (serializedValue.type === "Identifier") {
      let id = ((serializedValue: any): BabelNodeIdentifier);
      invariant(
        !this.preludeGenerator.derivedIds.has(id.name) ||
          this.emitter.cannotDeclare() ||
          this.emitter.hasBeenDeclared(val) ||
          (this.emitter.emittingToAdditionalFunction() && this.referencedDeclaredValues.get(val) === undefined)
      );
    }
    return serializedValue;
  }

  _serializeAbstractValue(val: AbstractValue): void | BabelNodeExpression {
    invariant(
      val.kind !== "sentinel member expression" && val.kind !== "sentinel ToObject",
      "invariant established by visitor"
    );
    if (val.hasIdentifier()) {
      return this._serializeAbstractValueHelper(val);
    } else {
      // This abstract value's dependencies should all be declared
      // but still need to check them again in case their serialized bodies are in different generator scope.
      this.emitter.emitNowOrAfterWaitingForDependencies(val.args, () => {
        const serializedValue = this._serializeAbstractValueHelper(val);
        let uid = this.getSerializeObjectIdentifier(val);
        this._declare(this.emitter.cannotDeclare(), "var", uid, serializedValue);
      });
    }
  }

  _serializeValue(val: Value): void | BabelNodeExpression {
    if (val instanceof AbstractValue) {
      return this._serializeAbstractValue(val);
    } else if (val.isIntrinsic()) {
      return this._serializeValueIntrinsic(val);
    } else if (val instanceof EmptyValue) {
      this.needsEmptyVar = true;
      return emptyExpression;
    } else if (val instanceof UndefinedValue) {
      return voidExpression;
    } else if (ResidualHeapInspector.isLeaf(val)) {
      return t.valueToNode(val.serialize());
    } else if (val instanceof ObjectValue) {
      let res;
      if (val instanceof ProxyValue) {
        return this._serializeValueProxy(val);
      } else if (IsArray(this.realm, val)) {
        res = this._serializeValueArray(val);
      } else if (val instanceof FunctionValue) {
        res = this._serializeValueFunction(val);
      } else {
        res = this.serializeValueObject(val);
      }
      let targetCommand = this.residualHeapInspector.getTargetIntegrityCommand(val);
      if (targetCommand) {
        this.emitter.emitNowOrAfterWaitingForDependencies([val], () => {
          let uid = this.getSerializeObjectIdentifier(val);
          this.emitter.emit(
            t.expressionStatement(
              t.callExpression(this.preludeGenerator.memoizeReference("Object." + targetCommand), [uid])
            )
          );
        });
      }
      return res;
    } else {
      invariant(val instanceof SymbolValue);
      return this._serializeValueSymbol(val);
    }
  }

  _serializeGlobalBinding(boundName: string, residualFunctionBinding: ResidualFunctionBinding) {
    invariant(!residualFunctionBinding.declarativeEnvironmentRecord);
    if (!residualFunctionBinding.serializedValue) {
      residualFunctionBinding.referentialized = true;
      if (boundName === "undefined") {
        residualFunctionBinding.serializedValue = voidExpression;
      } else {
        let value = this.realm.getGlobalLetBinding(boundName);
        // Check for let binding vs global property
        if (value) {
          let rval = residualFunctionBinding.value;
          invariant(rval !== undefined && value.equals(rval));
          let id = this.serializeValue(rval, true, "let");
          // increment ref count one more time as the value has been
          // referentialized (stored in a variable) by serializeValue
          this.residualHeapValueIdentifiers.incrementReferenceCount(rval);
          residualFunctionBinding.serializedValue = id;
        } else {
          residualFunctionBinding.serializedValue = this.preludeGenerator.globalReference(boundName);
        }
      }
    }
  }

  _withGeneratorScope(
    type: "Generator" | "AdditionalFunction",
    generator: Generator,
    callback: SerializedBody => void
  ): Array<BabelNodeStatement> {
    let newBody = { type, parentBody: undefined, entries: [], done: false };
    let isChild = type === "Generator";
    let oldBody = this.emitter.beginEmitting(generator, newBody, /*isChild*/ isChild);
    this.activeGeneratorBodies.set(generator, newBody);
    callback(newBody);
    this.activeGeneratorBodies.delete(generator);
    const statements = this.emitter.endEmitting(generator, oldBody, /*isChild*/ isChild).entries;
    if (this._options.debugScopes) {
      let comment = `generator "${generator.getName()}"`;
      let parent = this.getGeneratorParent(generator);
      if (parent !== undefined) {
        comment = `${comment} with parent "${parent.getName()}"`;
      }
      statements.unshift(commentStatement("begin " + comment));
      statements.push(commentStatement("end " + comment));
    }
    return statements;
  }

  _getContext(): SerializationContext {
    // TODO #482: Values serialized by nested generators would currently only get defined
    // along the code of the nested generator; their definitions need to get hoisted
    // or repeated so that they are accessible and defined from all using scopes
    let context = {
      serializeValue: this.serializeValue.bind(this),
      serializeBinding: this.serializeBinding.bind(this),
      serializeGenerator: (generator: Generator): Array<BabelNodeStatement> =>
        this._withGeneratorScope("Generator", generator, () => generator.serialize(context)),
      emit: (statement: BabelNodeStatement) => {
        this.emitter.emit(statement);
      },
      emitDefinePropertyBody: this.emitDefinePropertyBody.bind(this, false, undefined),
      canOmit: (value: AbstractValue) => {
        return !this.referencedDeclaredValues.has(value);
      },
      declare: (value: AbstractValue) => {
        this.emitter.declare(value);
      },
    };
    return context;
  }

  _shouldBeWrapped(body: Array<any>) {
    for (let i = 0; i < body.length; i++) {
      let item = body[i];
      if (item.type === "ExpressionStatement") {
        continue;
      } else if (item.type === "VariableDeclaration" || item.type === "FunctionDeclaration") {
        return true;
      } else if (item.type === "BlockStatement") {
        if (this._shouldBeWrapped(item.body)) {
          return true;
        }
      } else if (item.type === "IfStatement") {
        if (item.alternate) {
          if (this._shouldBeWrapped(item.alternate.body)) {
            return true;
          }
        }
        if (item.consequent) {
          if (this._shouldBeWrapped(item.consequent.body)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  _serializeAdditionalFunctionGeneratorAndEffects(generator: Generator, postGeneratorCallback: () => void) {
    let context = this._getContext();
    return this._withGeneratorScope("AdditionalFunction", generator, newBody => {
      let oldSerialiedValueWithIdentifiers = this._serializedValueWithIdentifiers;
      this._serializedValueWithIdentifiers = new Set(Array.from(this._serializedValueWithIdentifiers));
      try {
        generator.serialize(context);
        if (postGeneratorCallback) postGeneratorCallback();
      } finally {
        this._serializedValueWithIdentifiers = oldSerialiedValueWithIdentifiers;
      }
    });
  }

  // result -- serialize it, a return statement will be generated later, must be a Value
  // Generator -- visit all entries
  // Bindings -- only need to serialize bindings if they're captured by some nested function?
  //          -- need to apply them and maybe need to revisit functions in ancestors to make sure
  //          -- we don't overwrite anything they capture
  // PropertyBindings -- visit any property bindings that aren't to createdobjects
  // CreatedObjects -- should take care of itself
  _serializeAdditionalFunctionEffects(additionalFunctionValue: FunctionValue, effects: Effects) {
    let [result, , , modifiedProperties, createdObjects] = effects;
    for (let propertyBinding of modifiedProperties.keys()) {
      let object = propertyBinding.object;
      if (object instanceof ObjectValue && createdObjects.has(object)) continue;
      if (object.refuseSerialization) continue;
      if (object.isIntrinsic()) continue;
      invariant(object instanceof ObjectValue);
      this._emitProperty(object, propertyBinding.key, propertyBinding.descriptor, true);
    }
    invariant(result instanceof Value, "TODO: support PossiblyNormalCompletion return from additional function");
    // Handle ModifiedBindings
    let additionalFunctionValueInfo = this.additionalFunctionValueInfos.get(additionalFunctionValue);
    invariant(additionalFunctionValueInfo);
    for (let [modifiedBinding, residualBinding] of additionalFunctionValueInfo.modifiedBindings) {
      let newVal = modifiedBinding.value;
      invariant(newVal);
      residualBinding.additionalValueSerialized = this.serializeValue(newVal);
    }
    if (!(result instanceof UndefinedValue)) this.emitter.emit(t.returnStatement(this.serializeValue(result)));

    const lazyHoistedReactNodes = this.residualReactElementSerializer.serializeLazyHoistedNodes();
    Array.prototype.push.apply(this.mainBody.entries, lazyHoistedReactNodes);
  }

  _serializeAdditionalFunction(
    additionalFunctionValue: FunctionValue,
    { effects, transforms }: AdditionalFunctionEffects
  ) {
    let shouldEmitLog = !this.residualHeapValueIdentifiers.collectValToRefCountOnly;
    let [, generator, , , createdObjects] = effects;
    let nestedFunctions = new Set([...createdObjects].filter(object => object instanceof FunctionValue));
    // Allows us to emit function declarations etc. inside of this additional
    // function instead of adding them at global scope
    // TODO: make sure this generator isn't getting mutated oddly
    ((nestedFunctions: any): Set<FunctionValue>).forEach(val => this.additionalFunctionValueNestedFunctions.add(val));
    let body = this.realm.withEffectsAppliedInGlobalEnv(
      this._serializeAdditionalFunctionGeneratorAndEffects.bind(
        this,
        generator,
        this._serializeAdditionalFunctionEffects.bind(this, additionalFunctionValue, effects)
      ),
      effects
    );
    invariant(additionalFunctionValue instanceof ECMAScriptSourceFunctionValue);
    for (let transform of transforms) {
      transform(body);
    }
    this.rewrittenAdditionalFunctions.set(additionalFunctionValue, body);
    // re-resolve initialized modules to include things from additional functions
    this.modules.resolveInitializedModules();
    if (shouldEmitLog && this.modules.moduleIds.size > 0)
      console.log(
        `=== ${this.modules.initializedModules.size} of ${this.modules.moduleIds
          .size} modules initialized after additional function ${additionalFunctionValue.intrinsicName
          ? additionalFunctionValue.intrinsicName
          : ""}`
      );
  }

  prepareAdditionalFunctionValues() {
    let additionalFVEffects = this.additionalFunctionValuesAndEffects;
    if (additionalFVEffects)
      for (let [additionalFunctionValue, { effects }] of additionalFVEffects.entries()) {
        let generator = effects[1];
        invariant(!this.additionalFunctionGenerators.has(additionalFunctionValue));
        this.additionalFunctionGenerators.set(additionalFunctionValue, generator);
        invariant(!this.additionalFunctionGeneratorsInverse.has(generator));
        this.additionalFunctionGeneratorsInverse.set(generator, additionalFunctionValue);
      }
  }

  processAdditionalFunctionValues(): Map<FunctionValue, Array<BabelNodeStatement>> {
    let additionalFVEffects = this.additionalFunctionValuesAndEffects;
    if (!additionalFVEffects) return this.rewrittenAdditionalFunctions;
    for (let [additionalFunctionValue, effects] of additionalFVEffects.entries()) {
      this._serializeAdditionalFunction(additionalFunctionValue, effects);
    }
    return this.rewrittenAdditionalFunctions;
  }

  // Hook point for any serialization needs to be done after generator serialization is complete.
  postGeneratorSerialization(): void {
    // For overriding only.
  }

  serialize(): BabelNodeFile {
    this.prepareAdditionalFunctionValues();

    this.generator.serialize(this._getContext());
    invariant(this.emitter.declaredCount() <= this.preludeGenerator.derivedIds.size);

    this.postGeneratorSerialization();

    // TODO #20: add timers

    // TODO #21: add event listeners

    for (let [moduleId, moduleValue] of this.modules.initializedModules)
      this.requireReturns.set(moduleId, this.serializeValue(moduleValue));

    // Make sure additional functions get serialized.
    let rewrittenAdditionalFunctions = this.processAdditionalFunctionValues();

    Array.prototype.push.apply(this.prelude, this.preludeGenerator.prelude);

    this.modules.resolveInitializedModules();

    this.emitter.finalize();

    this.residualFunctions.residualFunctionInitializers.factorifyInitializers(this.factoryNameGenerator);
    let { unstrictFunctionBodies, strictFunctionBodies, requireStatistics } = this.residualFunctions.spliceFunctions(
      rewrittenAdditionalFunctions
    );
    if (this.modules.moduleIds.size > 0 && !this.residualHeapValueIdentifiers.collectValToRefCountOnly) {
      console.log(
        `=== ${this.modules.initializedModules.size} of ${this.modules.moduleIds
          .size} modules initialized, ${requireStatistics.replaced} of ${requireStatistics.count} require calls inlined.`
      );
    }

    // add strict modes
    let strictDirective = t.directive(t.directiveLiteral("use strict"));
    let globalDirectives = [];
    if (!this.realm.isStrict && !unstrictFunctionBodies.length && strictFunctionBodies.length) {
      // no unstrict functions, only strict ones
      globalDirectives.push(strictDirective);
    } else if (unstrictFunctionBodies.length && strictFunctionBodies.length) {
      // strict and unstrict functions
      funcLoop: for (let node of strictFunctionBodies) {
        if (t.isFunctionExpression(node)) {
          let func = ((node: any): BabelNodeFunctionExpression);
          if (func.body.directives) {
            for (let directive of func.body.directives) {
              if (directive.value.value === "use strict") {
                // already have a use strict directive
                continue funcLoop;
              }
            }
          } else func.body.directives = [];

          func.body.directives.unshift(strictDirective);
        }
      }
    }

    // build ast
    if (this.needsEmptyVar) {
      this.prelude.push(t.variableDeclaration("var", [t.variableDeclarator(emptyExpression, t.objectExpression([]))]));
    }
    if (this.needsAuxiliaryConstructor) {
      this.prelude.push(
        t.variableDeclaration("var", [
          t.variableDeclarator(constructorExpression, t.functionExpression(null, [], t.blockStatement([]))),
        ])
      );
    }

    let body = this.prelude.concat(this.emitter.getBody().entries);
    factorifyObjects(body, this.factoryNameGenerator);

    let ast_body = [];
    if (this.preludeGenerator.declaredGlobals.size > 0)
      ast_body.push(
        t.variableDeclaration(
          "var",
          Array.from(this.preludeGenerator.declaredGlobals).map(key => t.variableDeclarator(t.identifier(key)))
        )
      );
    if (body.length) {
      if (this.realm.isCompatibleWith("node-source-maps")) {
        ast_body.push(
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(
                t.callExpression(t.identifier("require"), [t.stringLiteral("source-map-support")]),
                t.identifier("install")
              ),
              []
            )
          )
        );
      }

      if (this._shouldBeWrapped(body)) {
        let globalExpression = this.realm.isCompatibleWith("node-cli") ? t.identifier("global") : t.thisExpression();

        let functionExpression = t.functionExpression(null, [], t.blockStatement(body, globalDirectives));
        let callExpression = this.preludeGenerator.usesThis
          ? t.callExpression(t.memberExpression(functionExpression, t.identifier("call")), [globalExpression])
          : t.callExpression(functionExpression, []);
        ast_body.push(t.expressionStatement(callExpression));
      } else {
        Array.prototype.push.apply(ast_body, body);
      }
    }

    // Make sure that the visitor visited as many values as the serializer
    invariant(
      this.serializedValues.size === this.residualValues.size,
      "serialized " + this.serializedValues.size + " of " + this.residualValues.size
    );

    // TODO: find better way to do this?
    // revert changes to functionInstances in case we do multiple serialization passes
    for (let instance of this.residualFunctionInstances.values()) {
      this.referentializer.cleanInstance(instance);
    }

    let program_directives = [];
    if (this.realm.isStrict) program_directives.push(strictDirective);
    return t.file(t.program(ast_body, program_directives));
  }
}
