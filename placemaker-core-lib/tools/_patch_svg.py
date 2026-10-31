# -*- coding: utf-8 -*-
"""一次性补丁：把 Program.BuildSvg 拆成单层入口 + 多图层渲染（阶段 4 用）。"""
import io

P = 'Driver/Program.cs'
s = io.open(P, encoding='utf-8').read()

START = '        /// <summary>\n        /// 通用渲染：任何 AreaPlan + 地块环 + 既有路网 → SVG。'
END = '            sb.Append("</svg>\\n");\n            return sb.ToString();\n        }\n'

i = s.index(START)
j = s.index(END) + len(END)

NEW = r'''        /// <summary>
        /// 通用渲染：任何 AreaPlan + 地块环 + 既有路网 → SVG。
        /// 阶段 2 用它画 7 个停车场景；扫街模式用它画每个生成器（同一个函数，避免两套画法漂移）。
        /// </summary>
        internal static string BuildSvg(float3[] ring, List<NearbyNet> roads, AreaPlan plan, string title, string subtitle)
            => BuildLayersSvg(ring, roads, new[] { plan }, title, subtitle);

        /// <summary>多图层里每条 AreaPlan 的区域描边色（按执行顺序轮转），用来一眼看出"哪个区域是谁填的"。</summary>
        internal static readonly string[] LayerPalette =
        {
            "#b04fbf", "#2f8f8f", "#c9772f", "#5a6fbf", "#a3543f", "#6f8f3f", "#8f5aa3", "#3f7f8f",
        };

        internal static string LayerColor(int index) => LayerPalette[((index % LayerPalette.Length) + LayerPalette.Length) % LayerPalette.Length];

        /// <summary>
        /// 多图层渲染（阶段 4）：一张 recipe 产出的每条 AreaPlan 按执行顺序叠画。填充仍是语义色
        /// （草地/铺装/水面/沥青），区域描边按图层上色，左下角图例列出每层 id、区域键与产出计数。
        /// </summary>
        internal static string BuildLayersSvg(float3[] ring, List<NearbyNet> roads, IList<AreaPlan> plans,
                                              string title, string subtitle)
        {
            float minX = float.MaxValue, minZ = float.MaxValue, maxX = float.MinValue, maxZ = float.MinValue;
            void Grow(float x, float z)
            {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            }
            void GrowRing(float3[] r)
            {
                if (r == null) return;
                foreach (var p in r) Grow(p.x, p.z);
            }

            foreach (var p in ring) Grow(p.x, p.z);

            // 路网也纳入包围盒（否则街道会画到画布外）
            const int RoadSamples = 16;
            foreach (var rd in roads)
                for (int i = 0; i <= RoadSamples; i++)
                {
                    var p = Bezier(rd.A, rd.B, rd.C, rd.D, i / (float)RoadSamples);
                    Grow(p.x - rd.Width, p.z - rd.Width);
                    Grow(p.x + rd.Width, p.z + rd.Width);
                }

            var list = plans ?? Array.Empty<AreaPlan>();
            foreach (var pl in list)
            {
                if (pl == null) continue;
                foreach (var sf in pl.Surfaces) GrowRing(sf.Ring);
                foreach (var ar in pl.Areas) GrowRing(ar.Ring);
                foreach (var rg in pl.Regions) GrowRing(rg.Ring);
                foreach (var ob in pl.Objects) Grow(ob.Position.x, ob.Position.z);
                foreach (var nt in pl.Nets)
                {
                    Grow(Math.Min(Math.Min(nt.A.x, nt.B.x), Math.Min(nt.C.x, nt.D.x)), Math.Min(Math.Min(nt.A.z, nt.B.z), Math.Min(nt.C.z, nt.D.z)));
                    Grow(Math.Max(Math.Max(nt.A.x, nt.B.x), Math.Max(nt.C.x, nt.D.x)), Math.Max(Math.Max(nt.A.z, nt.B.z), Math.Max(nt.C.z, nt.D.z)));
                }
                foreach (var z in pl.Zoning) { Grow(z.A.x, z.A.z); Grow(z.B.x, z.B.z); Grow(z.C.x, z.C.z); Grow(z.D.x, z.D.z); }
            }

            float w = maxX - minX, h = maxZ - minZ;
            if (w <= 0) w = 1;
            if (h <= 0) h = 1;

            double pad = 14;
            double target = 1100;
            double scale = (target - 2 * pad) / Math.Max(w, h);
            double pxW = w * scale + 2 * pad;
            int legendRows = Math.Min(list.Count, 12);
            double legendH = legendRows > 0 ? 16.0 * legendRows + 14 : 0;
            if (list.Count > 12) legendH += 16;
            double pxH = h * scale + 2 * pad + legendH;

            Func<float, float, string> P = (x, z) =>
                (pad + (x - minX) * scale).ToString("0.##", INV) + "," +
                (pad + (maxZ - z) * scale).ToString("0.##", INV);

            var sb = new StringBuilder();
            sb.Append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
            sb.Append("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"").Append(pxW.ToString("0", INV))
              .Append("\" height=\"").Append(pxH.ToString("0", INV))
              .Append("\" viewBox=\"0 0 ").Append(pxW.ToString("0", INV)).Append(' ').Append(pxH.ToString("0", INV)).Append("\">\n");
            sb.Append("<rect width=\"100%\" height=\"100%\" fill=\"#f7f5f0\"/>\n");

            // 0) 地块外的既有路网（画在地块下面，模拟"街"）
            if (roads.Count > 0)
            {
                sb.Append("<g id=\"site-roads\" fill=\"none\" stroke=\"#2b2b2b\" stroke-opacity=\"0.9\" stroke-linecap=\"round\">\n");
                foreach (var rd in roads)
                {
                    sb.Append("<path d=\"");
                    for (int i = 0; i <= RoadSamples; i++)
                    {
                        var p = Bezier(rd.A, rd.B, rd.C, rd.D, i / (float)RoadSamples);
                        sb.Append(i == 0 ? "M " : " L ").Append(P(p.x, p.z));
                    }
                    sb.Append("\" stroke-width=\"").Append((rd.Width * scale).ToString("0.##", INV)).Append("\"/>\n");
                }
                sb.Append("</g>\n");
            }

            for (int li = 0; li < list.Count; li++)
            {
                var plan = list[li];
                if (plan == null) continue;
                string tag = "L" + li;
                sb.Append("<g id=\"").Append(tag).Append("\" data-layer=\"").Append(Escape(plan.GeneratorId ?? "")).Append("\">\n");

                // 1) 曲面
                sb.Append("<g class=\"surfaces\">\n");
                foreach (var s in plan.Surfaces)
                {
                    if (s.Ring == null || s.Ring.Length < 3) continue;
                    sb.Append("<path d=\"");
                    for (int i = 0; i < s.Ring.Length; i++)
                        sb.Append(i == 0 ? "M " : " L ").Append(P(s.Ring[i].x, s.Ring[i].z));
                    sb.Append(" Z\" fill=\"").Append(RoleColor(s.Role)).Append("\" stroke=\"none\"/>\n");
                }
                sb.Append("</g>\n");

                // 1b) 分区格（zoning / polish 图层的真正产物：一格一个四边形，不是 surface）
                if (plan.Zoning.Count > 0)
                {
                    sb.Append("<g class=\"zoning\">\n");
                    foreach (var z in plan.Zoning)
                    {
                        sb.Append("<path d=\"M ").Append(P(z.A.x, z.A.z))
                          .Append(" L ").Append(P(z.B.x, z.B.z))
                          .Append(" L ").Append(P(z.C.x, z.C.z))
                          .Append(" L ").Append(P(z.D.x, z.D.z))
                          .Append(" Z\" fill=\"").Append(ZoneColor(z.ZoneId)).Append("\" fill-opacity=\"0.85\"/>\n");
                    }
                    sb.Append("</g>\n");
                }

                // 2) 通行区域
                if (plan.Areas.Count > 0)
                {
                    sb.Append("<g class=\"areas\" fill=\"none\" stroke=\"#2f6fb5\" stroke-width=\"0.8\" stroke-dasharray=\"6 4\">\n");
                    foreach (var a in plan.Areas)
                    {
                        if (a.Ring == null || a.Ring.Length < 3) continue;
                        sb.Append("<path d=\"");
                        for (int i = 0; i < a.Ring.Length; i++)
                            sb.Append(i == 0 ? "M " : " L ").Append(P(a.Ring[i].x, a.Ring[i].z));
                        sb.Append(" Z\"/>\n");
                    }
                    sb.Append("</g>\n");
                }

                // 3) 子区域：描边按图层上色 —— 这张图要回答的就是"父亲的哪个区域被谁填了"
                if (plan.Regions.Count > 0)
                {
                    sb.Append("<g class=\"regions\" fill=\"none\" stroke=\"").Append(LayerColor(li))
                      .Append("\" stroke-width=\"1.1\" stroke-dasharray=\"4 3\" opacity=\"0.9\">\n");
                    foreach (var rr in plan.Regions)
                    {
                        if (rr.Ring == null || rr.Ring.Length < 3) continue;
                        sb.Append("<path d=\"");
                        for (int i = 0; i < rr.Ring.Length; i++)
                            sb.Append(i == 0 ? "M " : " L ").Append(P(rr.Ring[i].x, rr.Ring[i].z));
                        sb.Append(" Z\"/>\n");
                    }
                    sb.Append("</g>\n");
                }

                // 4) 路网（内部车道/接驳，三次贝塞尔）
                if (plan.Nets.Count > 0)
                {
                    sb.Append("<g class=\"nets\" fill=\"none\" stroke=\"#1c1c1c\" stroke-opacity=\"0.85\" stroke-linecap=\"round\">\n");
                    foreach (var n in plan.Nets)
                    {
                        sb.Append("<path d=\"M ").Append(P(n.A.x, n.A.z))
                          .Append(" C ").Append(P(n.B.x, n.B.z))
                          .Append(' ').Append(P(n.C.x, n.C.z))
                          .Append(' ').Append(P(n.D.x, n.D.z))
                          .Append("\" stroke-width=\"").Append((NetWidth(n.Role) * scale).ToString("0.##", INV)).Append("\"/>\n");
                    }
                    sb.Append("</g>\n");
                }

                // 5) 物体
                if (plan.Objects.Count > 0)
                {
                    sb.Append("<g class=\"objects\">\n");
                    foreach (var o in plan.Objects)
                    {
                        sb.Append("<circle cx=\"").Append((pad + (o.Position.x - minX) * scale).ToString("0.##", INV))
                          .Append("\" cy=\"").Append((pad + (maxZ - o.Position.z) * scale).ToString("0.##", INV))
                          .Append("\" r=\"").Append((ObjectRadius(o.Role) * scale).ToString("0.##", INV))
                          .Append("\" fill=\"").Append(ObjectColor(o.Role)).Append("\" fill-opacity=\"0.95\"/>\n");
                    }
                    sb.Append("</g>\n");
                }

                sb.Append("</g>\n");
            }

            // 6) 地块边界
            sb.Append("<path d=\"");
            for (int i = 0; i < ring.Length; i++)
                sb.Append(i == 0 ? "M " : " L ").Append(P(ring[i].x, ring[i].z));
            sb.Append(" Z\" fill=\"none\" stroke=\"#c0392b\" stroke-width=\"2\" stroke-dasharray=\"10 6\"/>\n");

            sb.Append("<text x=\"").Append(pad.ToString("0", INV)).Append("\" y=\"").Append((pad + 3).ToString("0", INV))
              .Append("\" font-family=\"monospace\" font-size=\"15\" fill=\"#333\">")
              .Append(Escape(subtitle.Length > 0 ? title + " | " + subtitle : title))
              .Append("</text>\n");

            int totSurf = 0, totNet = 0, totObj = 0, totZone = 0, totReg = 0;
            foreach (var pl in list)
            {
                if (pl == null) continue;
                totSurf += pl.Surfaces.Count; totNet += pl.Nets.Count; totObj += pl.Objects.Count;
                totZone += pl.Zoning.Count; totReg += pl.Regions.Count;
            }
            sb.Append("<text x=\"").Append(pad.ToString("0", INV)).Append("\" y=\"").Append((pad + 19).ToString("0", INV))
              .Append("\" font-family=\"monospace\" font-size=\"13\" fill=\"#555\">")
              .Append(Escape("layers=" + list.Count + "  surfaces=" + totSurf + " nets=" + totNet + " objects=" + totObj +
                             " zoning=" + totZone + " regions=" + totReg))
              .Append("</text>\n");

            // 7) 图例（左下角，画布已为它留了高度）
            if (legendRows > 0)
            {
                double ly = h * scale + 2 * pad + 4;
                sb.Append("<g id=\"legend\" font-family=\"monospace\" font-size=\"12\" fill=\"#333\">\n");
                for (int li = 0; li < legendRows; li++)
                {
                    var plan = list[li];
                    double ry = ly + 16 * li;
                    sb.Append("<rect x=\"").Append(pad.ToString("0", INV)).Append("\" y=\"").Append((ry - 9).ToString("0.##", INV))
                      .Append("\" width=\"10\" height=\"10\" fill=\"none\" stroke=\"").Append(LayerColor(li)).Append("\" stroke-width=\"2\"/>\n");
                    string text = "#" + li + " " + (plan?.GeneratorId ?? "?") + " @" + (plan?.StepPath ?? "") +
                                  "  surf=" + (plan?.Surfaces.Count ?? 0) + " net=" + (plan?.Nets.Count ?? 0) +
                                  " obj=" + (plan?.Objects.Count ?? 0) + " reg=" + (plan?.Regions.Count ?? 0);
                    sb.Append("<text x=\"").Append((pad + 16).ToString("0", INV)).Append("\" y=\"").Append(ry.ToString("0.##", INV))
                      .Append("\">").Append(Escape(text)).Append("</text>\n");
                }
                if (list.Count > 12)
                    sb.Append("<text x=\"").Append((pad + 16).ToString("0", INV)).Append("\" y=\"").Append((ly + 16 * 12).ToString("0.##", INV))
                      .Append("\">+").Append(list.Count - 12).Append(" more layers</text>\n");
                sb.Append("</g>\n");
            }

            sb.Append("</svg>\n");
            return sb.ToString();
        }
'''

s = s[:i] + NEW + s[j:]
io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('patched', len(NEW), 'chars')
