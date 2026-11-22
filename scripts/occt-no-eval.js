// Removes the two places occt-import-js's Emscripten glue compiles code from a
// string. Embind's craftInvokerFunction builds every C++ binding with
// `new Function(...)` (and emval's method caller, below, does the same), which the 3D viewer's CSP blocks: the viewer allows
// 'wasm-unsafe-eval' for the STEP engine, never 'unsafe-eval'. The replacement
// is the closure form Emscripten itself emits with -sDYNAMIC_EXECUTION=0, so
// each binding wires its arguments, calls the C++ invoker and runs destructors
// exactly as the generated code does, without eval.
//
// Used by esbuild.web.js when bundling the glue, and by tests/step.test.ts,
// which runs the patched glue in a context that refuses code from strings.
'use strict';

const ORIGINAL =
  /function craftInvokerFunction\(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync\)\{[^]*?return createNamedFunction\(humanName,invokerFn\)\}/g;

const REPLACEMENT = [
  'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){',
  'var argCount=argTypes.length;',
  'if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and \'this\' types!")}',
  'var isClassMethodFunc=argTypes[1]!==null&&classType!==null;',
  'var needsDestructorStack=usesDestructorStack(argTypes);',
  'var returns=argTypes[0].name!=="void";',
  'var expected=argCount-2;',
  'var invokerFn=function(...args){',
  'var destructors=needsDestructorStack?[]:null;',
  'var wired=[cppTargetFunc];',
  'var thisWired;',
  'if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired)}',
  'var argsWired=new Array(expected);',
  'for(var i=0;i<expected;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,args[i]);wired.push(argsWired[i])}',
  'var rv=cppInvokerFunc(...wired);',
  'if(needsDestructorStack){runDestructors(destructors)}',
  'else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){',
  'var param=i===1?thisWired:argsWired[i-2];',
  'if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(param)}}}',
  'if(returns){return argTypes[0].fromWireType(rv)}',
  '};',
  'return createNamedFunction(humanName,invokerFn)}',
].join('');

// emval's method caller, used when C++ calls a JavaScript method through
// emscripten::val, builds its reader the same way. kind 1 constructs, kind 0
// calls on `obj`, any other kind passes the first argument as `this`, matching
// the generated `new func(...)` and `func.call(...)` forms.
const METHOD_CALLER =
  /var __emval_get_method_caller=\(argCount,argTypes,kind\)=>\{[^]*?return emval_addMethodCaller\(createNamedFunction\(functionName,invokerFunction\)\)\}/g;

const METHOD_CALLER_REPLACEMENT = [
  'var __emval_get_method_caller=(argCount,argTypes,kind)=>{',
  'var types=emval_lookupTypes(argCount,argTypes);',
  'var retType=types.shift();',
  'argCount--;',
  'var invokerFunction=function(obj,func,destructorsRef,args){',
  'var offset=0;',
  'var callArgs=new Array(argCount);',
  'for(var i=0;i<argCount;++i){callArgs[i]=types[i].readValueFromPointer(args+offset);offset+=types[i].argPackAdvance}',
  'var rv=kind===1?new func(...callArgs):kind===0?func.call(obj,...callArgs):func.call(...callArgs);',
  'if(!retType.isVoid){return emval_returnValue(retType,destructorsRef,rv)}',
  '};',
  'var functionName=`methodCaller<(${types.map(t=>t.name).join(", ")}) => ${retType.name}>`;',
  'return emval_addMethodCaller(createNamedFunction(functionName,invokerFunction))}',
].join('');

const PATCHES = [
  { name: 'craftInvokerFunction', pattern: ORIGINAL, replacement: REPLACEMENT },
  {
    name: '__emval_get_method_caller',
    pattern: METHOD_CALLER,
    replacement: METHOD_CALLER_REPLACEMENT,
  },
];

/**
 * Return the glue source with embind's eval-based invokers replaced. Throws if
 * the glue does not hold exactly one of each to replace, or still calls the
 * Function constructor afterwards, so an occt-import-js upgrade that changes
 * the glue fails the build instead of shipping a viewer that cannot start.
 */
function patchOcctGlue(source) {
  let patched = source;
  for (const { name, pattern, replacement } of PATCHES) {
    const found = patched.match(pattern) || [];
    if (found.length !== 1) {
      throw new Error(
        `occt-no-eval: expected one embind ${name} in the occt-import-js glue, found ${found.length}`,
      );
    }
    patched = patched.replace(pattern, () => replacement);
  }
  if (/newFunc\(Function\b|new Function\b|\beval\(/.test(patched)) {
    throw new Error('occt-no-eval: the occt-import-js glue still builds code from strings');
  }
  return patched;
}

module.exports = { patchOcctGlue };
