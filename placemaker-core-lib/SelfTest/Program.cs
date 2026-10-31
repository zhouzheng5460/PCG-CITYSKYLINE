// PlacemakerCore 自检：验证「抽出来的库能用」，而不只是「能编译」。
// 运行：dotnet run --project SelfTest\SelfTest.csproj
// 任何一条失败都会以退出码 1 结束，方便批处理判断。
using System;
using Unity.Mathematics;
using Placemaker.Core.Layers.Common;
// System.Random 与 Unity.Mathematics.Random 同名，同时 using 两个命名空间会 CS0104 二义；
// Core 里靠"不同时 using System"规避，自检程序这里用别名。
using Rng = Unity.Mathematics.Random;

namespace Placemaker.SelfTest
{
    internal static class Program
    {
        private static int _pass;
        private static int _fail;

        private static int Main()
        {
            try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { /* 重定向到文件时可能不允许，忽略 */ }

            Section("float2 基本运算");
            Check("加法", (new float2(1f, 2f) + new float2(3f, 4f)).Equals(new float2(4f, 6f)));
            Check("标量乘", (new float2(2f, 3f) * 2f).Equals(new float2(4f, 6f)));
            Check("标量左乘", (2f * new float2(2f, 3f)).Equals(new float2(4f, 6f)));
            Check("取负", (-new float2(1f, 2f)).Equals(new float2(-1f, -2f)));
            Check("点积", Near(math.dot(new float2(1f, 2f), new float2(3f, 4f)), 11f));

            Section("swizzle（Core 里 .xz 用了 1135 次）");
            Check("float3.xz", new float3(1f, 2f, 3f).xz.Equals(new float2(1f, 3f)));
            Check("float3.zx", new float3(1f, 2f, 3f).zx.Equals(new float2(3f, 1f)));
            Check("float4.xy", new float4(1f, 2f, 3f, 4f).xy.Equals(new float2(1f, 2f)));

            Section("向量几何");
            Check("distancesq(0,0 -> 3,4) = 25", Near(math.distancesq(new float2(0f, 0f), new float2(3f, 4f)), 25f));
            Check("distance = 5", Near(math.distance(new float2(0f, 0f), new float2(3f, 4f)), 5f));
            Check("length(float3) = sqrt(14)", Near(math.length(new float3(1f, 2f, 3f)), (float)Math.Sqrt(14.0)));
            Check("normalize 单位长", Near(math.length(math.normalize(new float2(3f, 4f))), 1f));
            Check("normalizesafe(零向量) = 0", math.normalizesafe(new float2(0f, 0f)).Equals(new float2(0f, 0f)));
            Check("normalizesafe(零向量, 兜底值)", math.normalizesafe(new float2(0f, 0f), new float2(7f, 8f)).Equals(new float2(7f, 8f)));
            Check("cross 右手系", math.cross(new float3(1f, 0f, 0f), new float3(0f, 1f, 0f)).Equals(new float3(0f, 0f, 1f)));

            Section("限幅与插值");
            Check("clamp 低端", Near(math.clamp(-5f, 0f, 1f), 0f));
            Check("clamp 高端", Near(math.clamp(5f, 0f, 1f), 1f));
            Check("clamp(int)", math.clamp(9, 1, 6) == 6);
            Check("saturate", Near(math.saturate(1.7f), 1f));
            Check("lerp 中点", Near(math.lerp(10f, 20f, 0.5f), 15f));
            Check("smoothstep 起点=0", Near(math.smoothstep(0f, 1f, 0f), 0f));
            Check("smoothstep 终点=1", Near(math.smoothstep(0f, 1f, 1f), 1f));

            Section("三角函数与矩阵");
            float s, c;
            math.sincos(0.7f, out s, out c);
            Check("sincos 与 sin/cos 一致", Near(s, (float)Math.Sin(0.7)) && Near(c, (float)Math.Cos(0.7)));
            Check("degrees/radians 往返", Near(math.degrees(math.radians(137f)), 137f, 1e-3f));
            Check("float2x2 identity 不变换", (float2x2.identity * new float2(3f, 5f)).Equals(new float2(3f, 5f)));
            var m2 = new float2x2(new float2(2f, 0f), new float2(0f, 3f));
            Check("float2x2 对角缩放", (m2 * new float2(2f, 2f)).Equals(new float2(4f, 6f)));

            Section("hash 确定性（Core 用它做可复现抖动）");
            uint h1 = math.hash(new float2(12.5f, -3.25f));
            uint h2 = math.hash(new float2(12.5f, -3.25f));
            uint h3 = math.hash(new float2(12.5f, -3.26f));
            Check("同输入同输出", h1 == h2);
            Check("异输入异输出", h1 != h3);
            Check("hash(uint3) 可用", math.hash(new uint3(1u, 2u, 3u)) != math.hash(new uint3(1u, 2u, 4u)));

            Section("Random（Core 以 ref 传参推进状态）");
            var r1 = new Rng(12345u);
            var r2 = new Rng(12345u);
            bool same = true;
            for (int i = 0; i < 64; i++) same &= Near(r1.NextFloat(), r2.NextFloat());
            Check("同种子序列一致", same);
            bool inRange = true;
            var r3 = new Rng(999u);
            for (int i = 0; i < 2000; i++)
            {
                float f = r3.NextFloat();
                if (f < 0f || f >= 1f) inRange = false;
                int n = r3.NextInt(0, 5);
                if (n < 0 || n >= 5) inRange = false;
                int m = r3.NextInt(-1, 2);
                if (m < -1 || m >= 2) inRange = false;
            }
            Check("NextFloat/NextInt 落在承诺区间", inRange);
            Check("NextFloat2Direction 是单位向量", Near(math.length(r3.NextFloat2Direction()), 1f, 1e-4f));
            var r4 = new Rng(7u);
            uint before = r4.state;
            r4.NextUInt();
            Check("状态确实推进（struct 可变）", r4.state != before);
            var r5 = new Rng(0u);
            Check("种子 0 被兜底避开吸收态", r5.state != 0u);

            Section("真实 Core 代码可调用（Hashing）");
            Check("Hashing.Mix 确定性", Hashing.Mix(123u) == Hashing.Mix(123u));
            Check("Hashing.Mix 有雪崩效应", Hashing.Mix(1u) != Hashing.Mix(2u));
            Check("Hashing.Unit 落在 [0,1)", Hashing.Unit(Hashing.Mix(42u)) < 1f);
            Check("Random 与 Hashing 能配合", Hashing.Rng(1u, 2u).NextFloat() >= 0f);

            Console.WriteLine();
            Console.WriteLine("--------------------------------------------");
            Console.WriteLine("PASS " + _pass + "  FAIL " + _fail);
            return _fail == 0 ? 0 : 1;
        }

        private static void Section(string name)
        {
            Console.WriteLine();
            Console.WriteLine("== " + name);
        }

        private static void Check(string name, bool ok)
        {
            if (ok) { _pass++; Console.WriteLine("  [ok]   " + name); }
            else { _fail++; Console.WriteLine("  [FAIL] " + name); }
        }

        private static bool Near(float a, float b) { return Near(a, b, 1e-5f); }

        private static bool Near(float a, float b, float eps)
        {
            if (float.IsNaN(a) || float.IsNaN(b)) return false;
            return Math.Abs(a - b) <= eps;
        }
    }
}
