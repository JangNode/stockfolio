import { NextRequest, NextResponse } from "next/server";
import {
  findByExactName,
  findNameByCode,
  searchStocks,
} from "@/lib/stockMaster";
import {
  findOverseasByCode,
  findOverseasByExactName,
  searchOverseasStocks,
} from "@/lib/stockMasterOverseas";
import { requireApproved } from "@/lib/requireApproved";

const CODE_PATTERN_KR = /^\d{6}$/;
// 미국 티커 표기(예: AAPL, BRK.B). KIS 마스터파일 심볼과 대소문자 없이 비교하므로
// 대문자로 정규화해서 판정한다.
const CODE_PATTERN_US = /^[A-Z]{1,5}(\.[A-Z])?$/;

export async function GET(request: NextRequest) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const market = request.nextUrl.searchParams.get("market") === "US" ? "US" : "KR";

  if (!query) {
    return NextResponse.json({ error: "검색어를 입력해주세요." }, { status: 400 });
  }

  try {
    if (market === "US") {
      const upper = query.toUpperCase();

      if (CODE_PATTERN_US.test(upper)) {
        const stock = await findOverseasByCode(upper);
        if (!stock) {
          return NextResponse.json(
            { error: "존재하지 않는 종목 코드입니다." },
            { status: 404 }
          );
        }
        return NextResponse.json({ code: stock.code, name: stock.name, exchange: stock.exchange });
      }

      const exact = await findOverseasByExactName(query);
      if (exact) {
        return NextResponse.json({ code: exact.code, name: exact.name, exchange: exact.exchange });
      }

      const matches = await searchOverseasStocks(query, 6);
      if (matches.length === 0) {
        return NextResponse.json(
          { error: "일치하는 종목을 찾을 수 없습니다. 티커로 입력해보세요." },
          { status: 404 }
        );
      }
      if (matches.length === 1) {
        const m = matches[0];
        return NextResponse.json({ code: m.code, name: m.name, exchange: m.exchange });
      }

      return NextResponse.json(
        {
          error: `여러 종목이 검색됩니다: ${matches
            .map((m) => `${m.name}(${m.code})`)
            .join(", ")}. 정확한 종목명이나 티커를 입력해주세요.`,
          candidates: matches,
        },
        { status: 409 }
      );
    }

    if (CODE_PATTERN_KR.test(query)) {
      const name = await findNameByCode(query);
      if (!name) {
        return NextResponse.json(
          { error: "존재하지 않는 종목코드입니다." },
          { status: 404 }
        );
      }
      return NextResponse.json({ code: query, name });
    }

    const exact = await findByExactName(query);
    if (exact) {
      return NextResponse.json(exact);
    }

    const matches = await searchStocks(query, 6);
    if (matches.length === 0) {
      return NextResponse.json(
        {
          error:
            "일치하는 종목을 찾을 수 없습니다. 종목코드로 입력해보세요.",
        },
        { status: 404 }
      );
    }
    if (matches.length === 1) {
      return NextResponse.json(matches[0]);
    }

    return NextResponse.json(
      {
        error: `여러 종목이 검색됩니다: ${matches
          .map((m) => `${m.name}(${m.code})`)
          .join(", ")}. 정확한 종목명이나 종목코드를 입력해주세요.`,
        candidates: matches,
      },
      { status: 409 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "종목 조회에 실패했습니다." },
      { status: 502 }
    );
  }
}
