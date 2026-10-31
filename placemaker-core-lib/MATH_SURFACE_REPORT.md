# Unity.Mathematics 兼容层静态核对

- Core .cs 文件：465，其中使用 math：341
- Core 用到 math 函数名：41；math 标识符：4
- 兼容层 math 方法数：47

## 1. 缺失的函数（编译器会报 CS0117）
无。

## 2. 参数个数不匹配（编译器会报 CS1501）
无。

## 3. 缺失的标识符（math.CONST）
无。

## 4. 缺失的类型成员（分量/静态属性）
无。

## 5. 缺失的构造重载
无。

## 附：Core 用到的全部 math 函数（按调用次数）
- max: 2243  arity=[2]
- min: 1572  arity=[2]
- distance: 1309  arity=[2]
- dot: 916  arity=[2]
- abs: 790  arity=[1]
- lerp: 728  arity=[3]
- normalizesafe: 633  arity=[1,2]
- clamp: 606  arity=[3]
- floor: 507  arity=[1]
- sin: 396  arity=[1]
- cos: 381  arity=[1]
- ceil: 344  arity=[1]
- sqrt: 300  arity=[1]
- atan2: 272  arity=[2]
- distancesq: 248  arity=[2]
- saturate: 229  arity=[1]
- round: 187  arity=[1]
- isfinite: 158  arity=[1]
- lengthsq: 121  arity=[1]
- length: 115  arity=[1]
- radians: 87  arity=[1]
- all: 63  arity=[1]
- normalize: 45  arity=[1]
- sign: 38  arity=[1]
- degrees: 35  arity=[1]
- cmax: 32  arity=[1]
- acos: 29  arity=[1]
- pow: 20  arity=[2]
- tan: 20  arity=[1]
- any: 19  arity=[1]
- sincos: 9  arity=[3]
- smoothstep: 9  arity=[3]
- asin: 6  arity=[1]
- cmin: 4  arity=[1]
- square: 4  arity=[1]
- hash: 4  arity=[1]
- exp: 3  arity=[1]
- cross: 2  arity=[2]
- atan: 2  arity=[1]
- select: 2  arity=[3]
- frac: 1  arity=[1]
